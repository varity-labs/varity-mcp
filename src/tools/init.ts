import { z } from "zod";
import { mkdir, access, rm, readFile, writeFile, cp } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, execNpx, execVaritykit, isCLIAvailable } from "../utils/cli-bridge.js";

/**
 * Check if a local template directory exists (for development/testing).
 * When running from source (not npm), prefer the local template over npx.
 */
async function getLocalTemplatePath(): Promise<string | null> {
  // Check common locations for the local template
  const candidates = [
    resolve(process.cwd(), "../varity-sdk-private/templates/saas-starter"),
    resolve(process.cwd(), "../../varity-sdk-private/templates/saas-starter"),
    // When running from varity-mcp-standalone/
    resolve(import.meta.dirname || "", "../../..", "varity-sdk-private/templates/saas-starter"),
  ];
  // Also check VARITY_TEMPLATE_DIR env var for explicit override
  if (process.env.VARITY_TEMPLATE_DIR) {
    candidates.unshift(resolve(process.env.VARITY_TEMPLATE_DIR));
  }
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, "package.json"));
      return candidate;
    } catch {
      // Not found — try next
    }
  }
  return null;
}

/**
 * Scaffold a project from a local template directory (no npm needed).
 */
async function scaffoldFromLocal(
  templateDir: string,
  projectPath: string,
  projectName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await cp(templateDir, projectPath, {
      recursive: true,
      filter: (src) => {
        // Skip node_modules, .next, out, .env.local from the template
        const rel = src.replace(templateDir, "");
        return !rel.includes("node_modules") && !rel.includes(".next") && !rel.includes("/out/") && !rel.includes(".env.local");
      },
    });

    // Update package.json with project name and real package versions
    const pkgPath = resolve(projectPath, "package.json");
    const pkgContent = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    pkg.name = projectName;
    pkg.version = "0.1.0";
    // Replace workspace:* deps with published npm registry versions.
    // Never use local file:// paths — developers need reproducible installs from npm.
    const PUBLISHED_VERSIONS: Record<string, string> = {
      "@varity-labs/sdk": "^2.0.0-beta.7",
      "@varity-labs/ui-kit": "^2.0.0-beta.7",
      "@varity-labs/types": "^2.0.0-beta.4",
    };

    for (const depKey of ["dependencies", "devDependencies"] as const) {
      const deps = pkg[depKey] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (typeof version === "string" && version.startsWith("workspace:")) {
          deps[name] = PUBLISHED_VERSIONS[name] ?? "latest";
        }
      }
    }
    delete pkg.scripts?.prepare; // Remove husky hook
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

    // Update varity.config.json — parse + reserialize for robustness.
    // Uses a fallback fresh config if the file is missing or corrupt so that
    // the app name is ALWAYS set correctly (BUG-003 fix).
    {
      const configPath = resolve(projectPath, "varity.config.json");
      let config: Record<string, unknown>;
      try {
        const configContent = await readFile(configPath, "utf-8");
        config = JSON.parse(configContent);
      } catch {
        // Config missing or unparseable — start fresh so name is always correct
        config = {
          version: "1.0.0",
          framework: "nextjs",
          hosting: "static",
          build: { command: "npm run build", output: "out" },
          database: { provider: "varity", collections: [] },
        };
      }
      config.name = projectName;
      // Normalize hosting value: "ipfs" is legacy; "static" is the canonical value
      if (config.hosting === "ipfs") config.hosting = "static";
      try {
        await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      } catch {
        // Non-critical: deploy will fall back to package.json name
      }
    }

    // Update APP_NAME in constants.ts — use a display-friendly title, not the raw slug.
    // e.g. "dx-final-test" → "DX Final Test" (short words uppercased, rest title-cased)
    try {
      const constantsPath = resolve(projectPath, "src/lib/constants.ts");
      const constantsContent = await readFile(constantsPath, "utf-8");
      const updated = constantsContent.replace("'TaskFlow'", `'${toDisplayName(projectName)}'`);
      await writeFile(constantsPath, updated, "utf-8");
    } catch {
      // Constants may not exist
    }

    // Patch next.config.js: suppress unused optional sub-modules from UI Kit
    try {
      const nextConfigPath = resolve(projectPath, "next.config.js");
      let nextConfig = await readFile(nextConfigPath, "utf-8");
      if (!nextConfig.includes("@solana/kit")) {
        // Add suppress array for optional peer deps
        nextConfig = nextConfig.replace(
          "'@react-native-async-storage/async-storage': false,\n    };",
          `'@react-native-async-storage/async-storage': false };\n    ['viem', 'viem/chains', '@solana/kit', '@solana/sysvars', '@solana-program/token-2022', 'x402', '@coinbase/wallet-sdk', '@walletconnect/ethereum-provider'].forEach(pkg => { config.resolve.alias[pkg] = false; });`
        );
      }
      // Suppress "Next.js inferred your workspace root" warning that appears when
      // the project lives inside a larger monorepo/workspace (e.g. the parent has
      // its own package-lock.json).  outputFileTracingRoot scopes tracing to the
      // project directory, preventing Next.js from walking up to the workspace root.
      if (!nextConfig.includes("outputFileTracingRoot")) {
        nextConfig = nextConfig.replace(
          "const nextConfig = {",
          `const nextConfig = {\n  outputFileTracingRoot: __dirname,`
        );
      }
      await writeFile(nextConfigPath, nextConfig, "utf-8");
    } catch {
      // next.config.js may not exist
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Convert a hyphenated project slug to a display-friendly title for APP_NAME.
 * e.g. "my-saas-app" → "My Saas App", "vc-demo-app" → "VC Demo App"
 * Only very short words (≤2 chars) are fully uppercased for acronyms like "vc", "ai", "dx".
 * Words of 3+ chars are title-cased: "app" → "App", "demo" → "Demo".
 */
function toDisplayName(slug: string): string {
  return slug
    .split("-")
    .map((word) =>
      word.length <= 2
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(" ");
}

/**
 * Resolve the working directory and project path from user inputs.
 *
 * Users commonly pass `path` as the full target (e.g. /tmp/my-app) even though
 * `name` already carries the project folder name.  We detect this and use the
 * parent as cwd so `create-varity-app <name>` creates the folder correctly.
 */
function resolveProjectPaths(
  name: string,
  path?: string
): { cwd: string; projectPath: string } {
  if (!path) {
    return { cwd: process.cwd(), projectPath: resolve(process.cwd(), name) };
  }

  const resolved = resolve(path);

  // If path ends with the project name, use its parent as cwd
  // e.g. path="/tmp/demo-app", name="demo-app" → cwd="/tmp"
  if (basename(resolved) === name) {
    return { cwd: dirname(resolved), projectPath: resolved };
  }

  // Otherwise path is the parent directory
  return { cwd: resolved, projectPath: resolve(resolved, name) };
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

async function runNpmInstall(projectPath: string): Promise<{ success: boolean; error?: string }> {
  // Always run npm install to ensure ALL dependencies are present.
  // Skipping based on node_modules/.bin/next existence caused BUG-003: 3 packages missing after init
  // because create-varity-app can partially install (main binaries present, some packages missing).
  // npm install is idempotent — it installs missing packages and is fast when most are already cached.

  // Remove any broken/partial node_modules before installing to avoid ENOTEMPTY errors.
  // This handles the case where create-varity-app partially installed deps (dirs present, .bin missing).
  const binPath = resolve(projectPath, "node_modules", ".bin");
  let hasBrokenInstall = false;
  try {
    await access(resolve(projectPath, "node_modules"));
    // node_modules exists — check if .bin is missing (broken partial install)
    try {
      await access(binPath);
    } catch {
      hasBrokenInstall = true;
    }
  } catch {
    // node_modules doesn't exist yet — normal state for fresh scaffold
  }

  if (hasBrokenInstall) {
    try {
      await rm(resolve(projectPath, "node_modules"), { recursive: true, force: true });
    } catch {
      // OK if removal fails
    }
  }

  try {
    const result = await execCLI("npm", ["install", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
      cwd: projectPath,
      timeout: 180_000,
    });
    return result.exitCode === 0
      ? { success: true }
      : { success: false, error: result.stderr || "npm install failed" };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export function registerInitTool(server: McpServer): void {
  server.registerTool(
    "varity_init",
    {
      title: "Create New App",
      description:
        "Create a new production-ready app with auth, database, and payments built in. " +
        "Scaffolds a Next.js project with Varity SDK, UI Kit, and a SaaS starter template. " +
        "The resulting project includes: dashboard, authentication (email/Google/GitHub), " +
        "settings page, landing page, command palette, and 20+ UI components. " +
        "Use this when a developer wants to start a new project, create an app, or scaffold something.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/, "Project name must be lowercase letters, numbers, and hyphens only")
          .describe(
            "Project name (lowercase, hyphens allowed, e.g., 'my-saas-app')"
          ),
        template: z
          .enum(["saas-starter"])
          .optional()
          .default("saas-starter")
          .describe("Template to use (default: 'saas-starter')"),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the parent directory where the project folder will be created. " +
            "Example: if path='/home/user/projects' and name='my-app', the project is created at '/home/user/projects/my-app'. " +
            "IMPORTANT: always pass an explicit absolute path (e.g. the user's home directory or workspace folder). " +
            "If omitted, the project is created inside the MCP server's working directory, which is rarely " +
            "the user's workspace root. Ask the user where they want the project if unsure."
          ),
      },
    },
    async ({ name, template, path }) => {
      const { cwd, projectPath } = resolveProjectPaths(name, path);

      // Ensure the parent directory exists
      try {
        await mkdir(cwd, { recursive: true });
      } catch (err) {
        return errorResponse(
          "PATH_ERROR",
          `Cannot create parent directory ${cwd}: ${err}`,
          "Check the path permissions and try again."
        );
      }

      // Try local template first (for development/testing — uses fixed template source)
      const localTemplate = await getLocalTemplatePath();
      if (localTemplate) {
        const scaffold = await scaffoldFromLocal(localTemplate, projectPath, name);
        if (scaffold.success) {
          const install = await runNpmInstall(projectPath);
          return successResponse(
            {
              project_name: name,
              project_path: projectPath,
              template,
              source: "local",
              deps_installed: install.success,
              ...(install.success ? {} : { note: "Dependencies not installed — run varity_install_deps to install them in one step." }),
              next_steps: install.success
                ? [`cd ${projectPath}`, "npm run dev", "# Use varity_dev_server to start the dev server — it auto-selects an available port", "# When ready: use varity_deploy"]
                : ["Run varity_install_deps to install dependencies", `cd ${projectPath}`, "npm run dev", "# When ready: use varity_deploy"],
            },
            install.success
              ? `Created "${name}" at ${projectPath} with dependencies installed. Ready to develop.`
              : `Created "${name}" at ${projectPath}. Run varity_install_deps to finish setup.`
          );
        }
        // Local scaffold failed — fall through to npx
      }

      // Fallback: npx create-varity-app (uses published package from npm)
      const args = [name];
      if (template && template !== "saas-starter") {
        args.push("--template", template);
      }

      const result = await execNpx("create-varity-app", args, {
        cwd,
        timeout: 180_000, // 3 minutes for scaffolding + npm install
      });

      if (result.exitCode === 0) {
        // Verify the project directory was actually created
        const created = await dirExists(projectPath);
        if (!created) {
          return errorResponse(
            "INIT_FAILED",
            "Command succeeded but the project directory was not created.",
            `Expected directory at ${projectPath}. Try running manually: npx create-varity-app ${name}`
          );
        }

        // Update varity.config.json — parse + reserialize for robustness.
        // Uses a fallback fresh config if the file is missing or corrupt so that
        // the app name is ALWAYS set correctly (BUG-003 fix).
        {
          const configPath = resolve(projectPath, "varity.config.json");
          let config: Record<string, unknown>;
          try {
            const configContent = await readFile(configPath, "utf-8");
            config = JSON.parse(configContent);
          } catch {
            // Config missing or unparseable — start fresh so name is always correct
            config = {
              version: "1.0.0",
              framework: "nextjs",
              hosting: "static",
              build: { command: "npm run build", output: "out" },
              database: { provider: "varity", collections: [] },
            };
          }
          config.name = name;
          if (config.hosting === "ipfs") config.hosting = "static";
          try {
            await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
          } catch {
            // Non-critical: deploy will fall back to package.json name
          }
        }

        // Update APP_NAME in constants.ts — use a display-friendly title, not the raw slug.
        // e.g. "dx-final-test" → "DX Final Test" (short words uppercased, rest title-cased)
        try {
          const constantsPath = resolve(projectPath, "src/lib/constants.ts");
          const constantsContent = await readFile(constantsPath, "utf-8");
          const updated = constantsContent.replace("'TaskFlow'", `'${toDisplayName(name)}'`);
          await writeFile(constantsPath, updated, "utf-8");
        } catch {
          // Constants may not exist
        }

        const install = await runNpmInstall(projectPath);

        return successResponse(
          {
            project_name: name,
            project_path: projectPath,
            template,
            deps_installed: install.success,
            ...(install.success ? {} : { note: "Dependencies not installed — run varity_install_deps to install them in one step." }),
            next_steps: install.success
              ? [
                  `cd ${projectPath}`,
                  "npm run dev",
                  "# Use varity_dev_server to start the dev server — it auto-selects an available port",
                  "# When ready: use varity_deploy",
                ]
              : [
                  "Run varity_install_deps to install dependencies",
                  `cd ${projectPath}`,
                  "npm run dev",
                  "# When ready: use varity_deploy",
                ],
            files_created: [
              "package.json",
              "next.config.js",
              "tailwind.config.ts",
              "src/app/layout.tsx",
              "src/app/page.tsx",
              "src/app/dashboard/",
              "src/app/login/",
            ],
          },
          install.success
            ? `Created "${name}" at ${projectPath} with dependencies installed. Ready to develop.`
            : `Created "${name}" at ${projectPath}. Run "npm install" to finish setup.`
        );
      }

      // npx exited non-zero — but the project may have been partially created
      // (template copied, npm install timed out or failed). Check before falling back.
      if (await dirExists(projectPath)) {
        const install = await runNpmInstall(projectPath);
        return successResponse(
          {
            project_name: name,
            project_path: projectPath,
            template,
            deps_installed: install.success,
            note: install.success
              ? "Project created and dependencies installed."
              : "Project created but dependencies could not be installed automatically. Run varity_install_deps to install them.",
            next_steps: install.success
              ? [`cd ${projectPath}`, "npm run dev", "# When ready: use varity_deploy"]
              : ["Run varity_install_deps to install dependencies", `cd ${projectPath}`, "npm run dev", "# When ready: use varity_deploy"],
          },
          install.success
            ? `Created "${name}" at ${projectPath} with dependencies installed. Ready to develop.`
            : `Created "${name}" at ${projectPath}. Run "npm install" to finish setup.`
        );
      }

      // Fallback: try varitykit init
      const hasVaritykit = await isCLIAvailable("varitykit");
      if (hasVaritykit) {
        const vkArgs = [name, "--template", template];
        const vkResult = await execVaritykit("init", vkArgs, {
          cwd,
          timeout: 180_000,
        });

        if (await dirExists(projectPath)) {
          const install = await runNpmInstall(projectPath);
          return successResponse(
            {
              project_name: name,
              project_path: projectPath,
              template,
              method: "varitykit",
              deps_installed: install.success,
              next_steps: install.success
                ? [`cd ${projectPath}`, "npm run dev", "# When ready: use varity_deploy"]
                : [`cd ${projectPath}`, "npm install", "npm run dev", "# When ready: use varity_deploy"],
            },
            install.success
              ? `Created "${name}" at ${projectPath} with dependencies installed. Ready to develop.`
              : `Created "${name}" at ${projectPath}. Run "npm install" to finish setup.`
          );
        }

        return errorResponse(
          "INIT_FAILED",
          `Failed to create project: ${vkResult.stderr || "(no output — the CLI may have crashed)"}`,
          "Try running manually: npx create-varity-app " + name
        );
      }

      // Both methods failed
      return errorResponse(
        "INIT_FAILED",
        `Failed to scaffold project: ${result.stderr || "(no output — npx may have failed to start)"}`,
        "Ensure Node.js >= 18 is installed and try: npx create-varity-app " +
          name
      );
    }
  );
}
