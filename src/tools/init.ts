import { z } from "zod";
import { mkdir, access, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, execNpx, execVaritykit, isCLIAvailable } from "../utils/cli-bridge.js";

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
  try {
    const result = await execCLI("npm", ["install"], { cwd: projectPath, timeout: 180_000 });
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
            "Directory to create the project in (default: current directory)"
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

      // Try npx create-varity-app first (preferred — no CLI install needed)
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

        const install = await runNpmInstall(projectPath);

        return successResponse(
          {
            project_name: name,
            project_path: projectPath,
            template,
            deps_installed: install.success,
            ...(install.success ? {} : { note: "Dependencies could not be installed automatically. Run npm install manually." }),
            next_steps: install.success
              ? [
                  `cd ${projectPath}`,
                  "npm run dev",
                  "# Open http://localhost:3000",
                  "# When ready: use varity_deploy",
                ]
              : [
                  `cd ${projectPath}`,
                  "npm install",
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
              : "Project created but dependencies could not be installed automatically. Run npm install manually.",
            next_steps: install.success
              ? [`cd ${projectPath}`, "npm run dev", "# When ready: use varity_deploy"]
              : [`cd ${projectPath}`, "npm install", "npm run dev", "# When ready: use varity_deploy"],
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
