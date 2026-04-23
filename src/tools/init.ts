import { z } from "zod";
import { mkdir, access, rm, readFile, writeFile, cp, readdir } from "node:fs/promises";
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
 * Patch project files that create-varity-app may ship with placeholder values:
 *  1. varity.config.json — set `name` to the actual project name
 *  2. src/lib/constants.ts — replace 'TaskFlow' with the display-friendly title
 *  3. next.config.js — ensure all optional-peer-dep webpack stubs are present
 *
 * Safe to call on both local-scaffold and npx-scaffolded projects.
 * All operations are best-effort (failures are silently ignored).
 */
async function patchProjectFiles(projectPath: string, name: string): Promise<void> {
  // 1. varity.config.json
  {
    const configPath = resolve(projectPath, "varity.config.json");
    let config: Record<string, unknown>;
    try {
      const configContent = await readFile(configPath, "utf-8");
      config = JSON.parse(configContent);
    } catch {
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
      // Non-critical
    }
  }

  // 2. constants.ts — replace placeholder app name with display-friendly title
  try {
    const constantsPath = resolve(projectPath, "src/lib/constants.ts");
    const constantsContent = await readFile(constantsPath, "utf-8");
    const updated = constantsContent.replace("'TaskFlow'", `'${toDisplayName(name)}'`);
    await writeFile(constantsPath, updated, "utf-8");
  } catch {
    // Constants may not exist
  }

  // 3. next.config.js — add webpack stubs for optional peer deps if not already present
  try {
    const nextConfigPath = resolve(projectPath, "next.config.js");
    let nextConfig = await readFile(nextConfigPath, "utf-8");
    let changed = false;
    const allStubsPresent = nextConfig.includes("'thirdweb'") && nextConfig.includes("thirdweb/extensions/erc20") && nextConfig.includes("@solana/kit");
    if (!allStubsPresent) {
      // Replace the old stub list with the complete one (covers every thirdweb subpath)
      const oldStubPattern = /\[(['"][^'"]*['"],?\s*)*\]\.forEach\(pkg => \{ config\.resolve\.alias\[pkg\] = false; \}\);/;
      const newStubs = `['@react-native-async-storage/async-storage', 'viem', 'viem/chains', 'thirdweb', 'thirdweb/chains', 'thirdweb/react', 'thirdweb/deploys', 'thirdweb/storage', 'thirdweb/wallets', 'thirdweb/wallets/in-app', 'thirdweb/extensions/erc20', 'wagmi', '@solana/kit', '@solana/sysvars', '@solana-program/token-2022', 'x402', '@coinbase/wallet-sdk', '@walletconnect/ethereum-provider'].forEach(pkg => { config.resolve.alias[pkg] = false; });`;
      if (oldStubPattern.test(nextConfig)) {
        nextConfig = nextConfig.replace(oldStubPattern, newStubs);
      } else {
        // Fallback: inject after webpack function open
        nextConfig = nextConfig.replace(
          "webpack: (config, { isServer, dev }) => {",
          `webpack: (config, { isServer, dev }) => {\n    // Suppress unused optional peer dependencies from UI Kit internals\n    ${newStubs}`
        );
      }
      changed = true;
    }
    if (!nextConfig.includes("outputFileTracingRoot")) {
      nextConfig = nextConfig.replace(
        "const nextConfig = {",
        `const nextConfig = {\n  outputFileTracingRoot: __dirname,`
      );
      changed = true;
    }
    if (changed) {
      await writeFile(nextConfigPath, nextConfig, "utf-8");
    }
  } catch {
    // next.config.js may not exist
  }
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

    // Verify that essential source files were actually copied.
    // If the template has issues (large node_modules causing cp to abort, broken
    // symlinks, etc.), the copy may produce only a partial directory.
    // Fail fast here so the caller can clean up and fall through to npx.
    try {
      await access(resolve(projectPath, "src"));
      await access(resolve(projectPath, "package.json"));
    } catch {
      return {
        success: false,
        error:
          "Template copy appears incomplete — 'src/' or 'package.json' not found after copy. Falling back to npx create-varity-app.",
      };
    }

    // Update package.json with project name and real package versions
    const pkgPath = resolve(projectPath, "package.json");
    const pkgContent = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    pkg.name = projectName;
    pkg.version = "0.1.0";
    // Replace workspace:* deps with published npm registry versions.
    // Never use local file:// paths — developers need reproducible installs from npm.
    const PUBLISHED_VERSIONS: Record<string, string> = {
      "@tanstack/react-query": "^5.0.0",
      "@varity-labs/sdk": "^2.0.0-beta.14",
      "@varity-labs/ui-kit": "^2.0.0-beta.15",
      "@varity-labs/types": "^2.0.0-beta.8",
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

    // Patch project files: varity.config.json, constants.ts, next.config.js
    await patchProjectFiles(projectPath, projectName);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/** Business acronyms that should always appear fully uppercased in display names. */
const DISPLAY_NAME_ACRONYMS = new Set([
  'crm', 'api', 'saas', 'ui', 'ux', 'db', 'id', 'hr',
  'b2b', 'b2c', 'ai', 'ml', 'sdk', 'url', 'seo', 'kpi', 'cms', 'erp',
]);

/**
 * Convert a hyphenated project slug to a display-friendly title for APP_NAME.
 * e.g. "my-saas-app" → "My SaaS App", "custom-crm" → "Custom CRM"
 * Recognizes common business acronyms (crm, api, saas, etc.) and uppercases them.
 * Very short words (≤2 chars) are also fully uppercased (e.g. "vc" → "VC").
 * Words of 3+ chars with no acronym match are title-cased: "app" → "App".
 */
function toDisplayName(slug: string): string {
  return slug
    .split("-")
    .map((word) => {
      const lower = word.toLowerCase();
      if (DISPLAY_NAME_ACRONYMS.has(lower)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
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

async function depsActuallyInstalled(projectPath: string): Promise<boolean> {
  try {
    const binDir = resolve(projectPath, "node_modules", ".bin");
    const binFiles = await readdir(binDir);
    if (binFiles.length > 0) return true;
  } catch {
    // .bin missing — check raw package count as fallback
  }
  try {
    const nmDir = resolve(projectPath, "node_modules");
    const entries = await readdir(nmDir);
    return entries.filter((e) => !e.startsWith(".")).length > 50;
  } catch {
    return false;
  }
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
    if (result.exitCode === 0) {
      return { success: true };
    }
    // Non-zero exit — but check if packages were actually installed.
    // npm 10+ can exit non-zero due to peer dep warnings even when all packages install successfully.
    try {
      const binDir = resolve(projectPath, "node_modules", ".bin");
      const binFiles = await readdir(binDir);
      if (binFiles.length > 0) {
        return { success: true }; // packages installed despite non-zero exit code
      }
    } catch {
      // .bin doesn't exist — install genuinely failed
    }
    return { success: false, error: result.stderr || "npm install failed" };
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
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Overwrite files in an existing non-empty directory. " +
            "WARNING: existing files will be replaced without backup. " +
            "Default: false. Only set true when the user explicitly requests overwriting."
          ),
      },
    },
    async ({ name, template, path, force }) => {
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

      // Guard: refuse to overwrite a non-empty directory unless force=true
      if (await dirExists(projectPath)) {
        const entries = await readdir(projectPath).catch(() => [] as string[]);
        if (entries.length > 0 && !force) {
          return errorResponse(
            "DIR_NOT_EMPTY",
            `Directory "${projectPath}" already exists and is not empty (${entries.length} item${entries.length === 1 ? "" : "s"} found).`,
            "Use force=true to overwrite existing files, or choose a different project name."
          );
        }
      }

      // Try local template first (for development/testing — uses fixed template source)
      const localTemplate = await getLocalTemplatePath();
      if (localTemplate) {
        const scaffold = await scaffoldFromLocal(localTemplate, projectPath, name);
        if (scaffold.success) {
          const install = await runNpmInstall(projectPath);
          const depsInstalled = install.success || await depsActuallyInstalled(projectPath);
          return successResponse(
            {
              project_name: name,
              project_path: projectPath,
              template,
              source: "local",
              deps_installed: depsInstalled,
              ...(!depsInstalled ? { note: "Dependencies not installed — run varity_install_deps to install them in one step." } : {}),
              template_collections: {
                built_in: ["projects", "tasks", "team_members", "user_settings"],
                note: "These names are already in the template. Use different names with varity_add_collection to avoid conflicts.",
              },
              next_steps: depsInstalled
                ? [`cd ${projectPath}`, "Call varity_dev_server to start the development server", "When ready to deploy: call varity_deploy"]
                : ["Call varity_install_deps to install dependencies", `cd ${projectPath}`, "Then call varity_dev_server to start the development server"],
            },
            depsInstalled
              ? `Created "${name}" at ${projectPath} with dependencies installed. Ready to develop.`
              : `Created "${name}" at ${projectPath}. Run varity_install_deps to finish setup.`
          );
        }
        // Local scaffold failed — clean up any partial directory so npx has a clean slate.
        // Without this cleanup, npx create-varity-app refuses to init into an existing
        // directory and the fallback silently returns the partial directory as "success".
        try {
          await rm(projectPath, { recursive: true, force: true });
        } catch {
          // Cleanup failure is non-critical — npx will fail with a clear error if needed
        }
        // Fall through to npx
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

        // Patch project files: varity.config.json name, constants.ts APP_NAME, next.config.js webpack stubs
        await patchProjectFiles(projectPath, name);

        // Ensure package.json uses current published versions (create-varity-app on npm may ship older pinned versions)
        try {
          const pkgPath = resolve(projectPath, "package.json");
          const pkgRaw = await readFile(pkgPath, "utf-8");
          const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          const LATEST_VERSIONS: Record<string, string> = {
            "@tanstack/react-query": "^5.0.0",
            "@varity-labs/sdk": "^2.0.0-beta.14",
            "@varity-labs/ui-kit": "^2.0.0-beta.15",
            "@varity-labs/types": "^2.0.0-beta.8",
          };
          let pkgChanged = false;
          for (const depKey of ["dependencies", "devDependencies"] as const) {
            const deps = pkg[depKey];
            if (!deps) continue;
            for (const [pkgName, latestVer] of Object.entries(LATEST_VERSIONS)) {
              if (deps[pkgName] !== undefined && deps[pkgName] !== latestVer) {
                deps[pkgName] = latestVer;
                pkgChanged = true;
              }
            }
          }
          if (pkgChanged) {
            await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
          }
        } catch {
          // Non-critical — package.json versioning is cosmetic
        }

        const install = await runNpmInstall(projectPath);
        const depsInstalled = install.success || await depsActuallyInstalled(projectPath);

        return successResponse(
          {
            project_name: name,
            project_path: projectPath,
            template,
            deps_installed: depsInstalled,
            ...(!depsInstalled ? { note: "Dependencies not installed — run varity_install_deps to install them in one step." } : {}),
            template_collections: {
              built_in: ["projects", "tasks", "team_members", "user_settings"],
              note: "These names are already in the template. Use different names with varity_add_collection to avoid conflicts.",
            },
            next_steps: depsInstalled
              ? [
                  `cd ${projectPath}`,
                  "Call varity_dev_server to start the development server",
                  "When ready to deploy: call varity_deploy",
                ]
              : [
                  "Call varity_install_deps to install dependencies",
                  `cd ${projectPath}`,
                  "Then call varity_dev_server to start the development server",
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
            : `Created "${name}" at ${projectPath}. Run varity_install_deps to finish setup.`
        );
      }

      // npx exited non-zero — but the project may have been partially created
      // (template copied, npm install timed out or failed). Check before falling back.
      if (await dirExists(projectPath)) {
        // Patch even in the partial-install path — the template files are present
        await patchProjectFiles(projectPath, name);

        // Ensure package.json uses current published versions (create-varity-app on npm may ship older pinned versions)
        try {
          const pkgPath = resolve(projectPath, "package.json");
          const pkgRaw = await readFile(pkgPath, "utf-8");
          const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          const LATEST_VERSIONS: Record<string, string> = {
            "@tanstack/react-query": "^5.0.0",
            "@varity-labs/sdk": "^2.0.0-beta.14",
            "@varity-labs/ui-kit": "^2.0.0-beta.15",
            "@varity-labs/types": "^2.0.0-beta.8",
          };
          let pkgChanged = false;
          for (const depKey of ["dependencies", "devDependencies"] as const) {
            const deps = pkg[depKey];
            if (!deps) continue;
            for (const [pkgName, latestVer] of Object.entries(LATEST_VERSIONS)) {
              if (deps[pkgName] !== undefined && deps[pkgName] !== latestVer) {
                deps[pkgName] = latestVer;
                pkgChanged = true;
              }
            }
          }
          if (pkgChanged) {
            await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
          }
        } catch {
          // Non-critical — package.json versioning is cosmetic
        }

        const install = await runNpmInstall(projectPath);
        const depsInstalled = install.success || await depsActuallyInstalled(projectPath);
        return successResponse(
          {
            project_name: name,
            project_path: projectPath,
            template,
            deps_installed: depsInstalled,
            note: depsInstalled
              ? "Project created and dependencies installed."
              : "Project created but dependencies could not be installed automatically. Run varity_install_deps to install them.",
            template_collections: {
              built_in: ["projects", "tasks", "team_members", "user_settings"],
              note: "These names are already in the template. Use different names with varity_add_collection to avoid conflicts.",
            },
            next_steps: depsInstalled
              ? [`cd ${projectPath}`, "Call varity_dev_server to start the development server", "When ready to deploy: call varity_deploy"]
              : ["Call varity_install_deps to install dependencies", `cd ${projectPath}`, "Then call varity_dev_server to start the development server"],
          },
          depsInstalled
            ? `Created "${name}" at ${projectPath} with dependencies installed. Ready to develop.`
            : `Created "${name}" at ${projectPath}. Run varity_install_deps to finish setup.`
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
          await patchProjectFiles(projectPath, name);
          const install = await runNpmInstall(projectPath);
          const depsInstalled = install.success || await depsActuallyInstalled(projectPath);
          return successResponse(
            {
              project_name: name,
              project_path: projectPath,
              template,
              method: "varitykit",
              deps_installed: depsInstalled,
              template_collections: {
                built_in: ["projects", "tasks", "team_members", "user_settings"],
                note: "These names are already in the template. Use different names with varity_add_collection to avoid conflicts.",
              },
              next_steps: depsInstalled
                ? [`cd ${projectPath}`, "Call varity_dev_server to start the development server", "When ready to deploy: call varity_deploy"]
                : ["Call varity_install_deps to install dependencies", `cd ${projectPath}`, "Then call varity_dev_server to start the development server"],
            },
            depsInstalled
              ? `Created "${name}" at ${projectPath} with dependencies installed. Ready to develop.`
              : `Created "${name}" at ${projectPath}. Run varity_install_deps to finish setup.`
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
