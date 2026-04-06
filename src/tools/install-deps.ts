import { z } from "zod";
import { access } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI } from "../utils/cli-bridge.js";

export function registerInstallDepsTool(server: McpServer): void {
  server.registerTool(
    "varity_install_deps",
    {
      title: "Install Dependencies",
      description:
        "Install npm dependencies in a Varity project. Use after creating a project or when adding new packages.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Project directory to install dependencies in (default: current directory)"
          ),
        packages: z
          .array(z.string())
          .optional()
          .describe(
            "Specific packages to install (e.g., ['axios', 'lodash']). If omitted, runs npm install for all dependencies."
          ),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ path, packages }) => {
      const cwd = path || process.cwd();

      // Validate that the project directory exists
      try {
        await access(cwd);
      } catch {
        return errorResponse(
          "PATH_NOT_FOUND",
          `Project directory does not exist: ${cwd}`,
          "Check the path and ensure the project has been created (use varity_init first)."
        );
      }

      const args = packages && packages.length > 0
        ? ["install", ...packages]
        : ["install"];

      const result = await execCLI("npm", args, {
        cwd,
        timeout: 180_000, // 3 minutes
      });

      const output = result.stdout + "\n" + result.stderr;

      if (result.exitCode === 0) {
        // Parse the number of packages installed from npm output
        const addedMatch = output.match(/added (\d+) packages?/);
        const packageCount = addedMatch ? parseInt(addedMatch[1]!, 10) : 0;

        return successResponse(
          {
            installed: true,
            package_count: packageCount,
            output: output.trim(),
          },
          packages && packages.length > 0
            ? `Installed ${packages.join(", ")} successfully.`
            : `Dependencies installed successfully (${packageCount} packages).`
        );
      }

      // Installation failed
      if (output.includes("ENOENT") || output.includes("no such file")) {
        return errorResponse(
          "NO_PACKAGE_JSON",
          `No package.json found in: ${cwd}`,
          "Ensure you are in a project directory with a package.json file. Use varity_init to create a new project."
        );
      }

      if (output.includes("ERESOLVE") || output.includes("peer dep")) {
        return errorResponse(
          "DEPENDENCY_CONFLICT",
          `Dependency conflict: ${output.substring(0, 500)}`,
          "Try running with --legacy-peer-deps or check for conflicting package versions."
        );
      }

      return errorResponse(
        "INSTALL_FAILED",
        `npm install failed: ${output.substring(0, 500)}`,
        "Check the error above. Ensure Node.js >= 18 and npm are installed."
      );
    }
  );
}
