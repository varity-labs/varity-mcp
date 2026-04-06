import { z } from "zod";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI } from "../utils/cli-bridge.js";

/** Check if a directory exists. */
async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

/** Detect the output directory based on framework. */
async function detectOutputDir(cwd: string): Promise<string | null> {
  const candidates = [".next", "out", "dist", "build"];
  for (const dir of candidates) {
    if (await dirExists(resolve(cwd, dir))) {
      return dir;
    }
  }
  return null;
}

/** Parse build errors from combined output. */
function parseBuildErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("Error:") ||
      trimmed.startsWith("error ") ||
      trimmed.includes("Module not found") ||
      trimmed.includes("Type error") ||
      trimmed.includes("SyntaxError") ||
      trimmed.includes("Cannot find module")
    ) {
      errors.push(trimmed);
    }
  }
  return errors;
}

export function registerBuildTool(server: McpServer): void {
  server.registerTool(
    "varity_build",
    {
      title: "Build Project",
      description:
        "Build the project for production. Auto-detects framework from package.json. " +
        "Run before deploying or to verify the project compiles.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Path to the project directory (default: current directory)"
          ),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ path }) => {
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

      // Verify package.json exists and has a build script
      const packageJsonPath = resolve(cwd, "package.json");
      try {
        const raw = await readFile(packageJsonPath, "utf-8");
        const pkg = JSON.parse(raw);
        if (!pkg.scripts?.build) {
          return errorResponse(
            "NO_BUILD_SCRIPT",
            'No "build" script found in package.json.',
            'Add a build script to package.json (e.g., "build": "next build") or check that you are in the correct directory.'
          );
        }
      } catch {
        return errorResponse(
          "NO_PACKAGE_JSON",
          `No package.json found in: ${cwd}`,
          "Ensure you are in a project directory with a package.json file. Use varity_init to create a new project."
        );
      }

      const result = await execCLI("npm", ["run", "build"], {
        cwd,
        timeout: 300_000, // 5 minutes
      });

      const output = result.stdout + "\n" + result.stderr;
      const errors = parseBuildErrors(output);

      if (result.exitCode === 0) {
        const outputDir = await detectOutputDir(cwd);

        return successResponse(
          {
            success: true,
            output_dir: outputDir,
            errors: [],
          },
          outputDir
            ? `Build succeeded! Output in ${outputDir}/.`
            : "Build succeeded!"
        );
      }

      // Build failed
      return errorResponse(
        "BUILD_FAILED",
        errors.length > 0
          ? `Build failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${errors.slice(0, 10).join("\n")}`
          : `Build failed: ${output.substring(0, 500)}`,
        "Fix the errors above and try building again. Common fixes: install missing dependencies (varity_install_deps), check for TypeScript errors."
      );
    }
  );
}
