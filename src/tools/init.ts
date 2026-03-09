import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execNpx, execVaritykit, isCLIAvailable } from "../utils/cli-bridge.js";

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
      const cwd = path || process.cwd();

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
        const projectPath = `${cwd}/${name}`;
        return successResponse(
          {
            project_name: name,
            project_path: projectPath,
            template,
            next_steps: [
              `cd ${name}`,
              "npm run dev",
              "# Open http://localhost:3000",
              "# When ready: varitykit app deploy",
            ],
            files_created: [
              "package.json",
              "next.config.js",
              "tailwind.config.ts",
              "src/app/layout.tsx",
              "src/app/page.tsx",
              "src/app/(dashboard)/",
              "src/app/(auth)/",
            ],
          },
          `Created "${name}" with the ${template} template at ${projectPath}. Run "cd ${name} && npm run dev" to start developing.`
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

        if (vkResult.exitCode === 0) {
          return successResponse(
            {
              project_name: name,
              project_path: `${cwd}/${name}`,
              template,
              method: "varitykit",
              next_steps: [
                `cd ${name}`,
                "npm install",
                "npm run dev",
                "# When ready: varitykit app deploy",
              ],
            },
            `Created "${name}" with varitykit. Run "cd ${name} && npm install && npm run dev" to start.`
          );
        }

        return errorResponse(
          "INIT_FAILED",
          `Failed to create project: ${vkResult.stderr}`,
          "Try running manually: npx create-varity-app " + name
        );
      }

      // Both methods failed
      return errorResponse(
        "INIT_FAILED",
        `Failed to scaffold project: ${result.stderr}`,
        "Ensure Node.js >= 18 is installed and try: npx create-varity-app " +
          name
      );
    }
  );
}
