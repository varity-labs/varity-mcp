import { z } from "zod";
import { access, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
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

      // Proactively detect broken node_modules BEFORE npm runs.
      // varity_init / create-varity-app sometimes leaves a partial install
      // (package dirs present but .bin/ symlinks missing). Detect and clean.
      const nodeModulesPath = resolve(cwd, "node_modules");
      const binPath = resolve(nodeModulesPath, ".bin");
      try {
        await access(nodeModulesPath);
        // node_modules exists — check if .bin/ exists too
        try {
          await access(binPath);
          // Both exist — check if it has actual binaries
          const binFiles = await readdir(binPath);
          if (binFiles.length === 0) {
            // .bin/ exists but is empty — broken state
            await rm(nodeModulesPath, { recursive: true, force: true });
          }
        } catch {
          // node_modules exists but .bin/ doesn't — broken partial install
          await rm(nodeModulesPath, { recursive: true, force: true });
        }
      } catch {
        // node_modules doesn't exist — that's fine, npm install will create it
      }

      // Use --legacy-peer-deps to handle transitive dependency conflicts that cause npm to exit
      // non-zero even though packages install successfully.
      const baseArgs = packages && packages.length > 0
        ? ["install", ...packages]
        : ["install", "--legacy-peer-deps"];

      const result = await execCLI("npm", baseArgs, {
        cwd,
        timeout: 180_000, // 3 minutes
      });

      const output = result.stdout + "\n" + result.stderr;
      const addedMatch = output.match(/added (\d+) packages?/);
      const packageCount = addedMatch ? parseInt(addedMatch[1]!, 10) : 0;
      // Extract changed package names from npm output for transparency
      const changedMatch = output.match(/changed (\d+) packages?/);
      const upToDate = output.includes("up to date");
      const installSummary = upToDate
        ? "All dependencies already installed (up to date)."
        : packageCount > 0
          ? `Installed ${packageCount} new packages.`
          : changedMatch
            ? `Updated ${changedMatch[1]} packages.`
            : "Dependencies verified.";

      // SUCCESS CHECK — Multiple signals, in priority order:
      // 1. Exit code 0 = definitive success
      // 2. "added N packages" in output = success even if exit code non-zero (peer dep warnings)
      // 3. node_modules/.bin/ has binaries = success (npm completed even if it complained)
      //
      // npm writes deprecation warnings to stderr even on success and sometimes
      // exits non-zero for peer dep conflicts that don't actually break anything.
      // NEVER treat warnings as errors.

      // Check 1: exit code
      if (result.exitCode === 0) {
        // Try to extract package names from npm output (npm v6 shows "+ pkg@ver" lines)
        const installedNames = output
          .split("\n")
          .filter((line) => /^\+\s+\S+@\S+/.test(line.trim()))
          .map((line) => line.trim().replace(/^\+\s+/, "").split(" ")[0])
          .filter(Boolean)
          .slice(0, 10); // cap at 10 to keep output readable
        return successResponse(
          {
            installed: true,
            package_count: packageCount,
            ...(upToDate && installedNames.length === 0 && packageCount === 0 && { already_installed: true }),
            ...(installedNames.length > 0 && { packages_installed: installedNames }),
          },
          packages && packages.length > 0
            ? `Installed ${packages.join(", ")} successfully.`
            : installedNames.length > 0
              ? `Installed ${packageCount} packages: ${installedNames.join(", ")}.`
              : upToDate
                ? "Dependencies are up to date — nothing installed."
                : installSummary
        );
      }

      // Check 2: packages were added despite non-zero exit
      if (packageCount > 0) {
        return successResponse(
          { installed: true, package_count: packageCount, note: "Installed with non-critical warnings." },
          `Dependencies installed successfully (${packageCount} packages, with warnings).`
        );
      }

      // Check 3: node_modules/.bin/ has content — npm finished but output was truncated/buffered
      try {
        const binDir = resolve(cwd, "node_modules", ".bin");
        const binFiles = await readdir(binDir);
        if (binFiles.length > 0) {
          return successResponse(
            { installed: true, package_count: binFiles.length, note: "Verified via installed binaries." },
            `Dependencies installed successfully (${binFiles.length} binaries available).`
          );
        }
      } catch {
        // .bin doesn't exist — fall through to error handling
      }

      // Check 4: node_modules exists with packages but no .bin — partial install, try to fix
      try {
        const nmDir = resolve(cwd, "node_modules");
        const nmContents = await readdir(nmDir);
        if (nmContents.length > 10) {
          // Packages exist but binaries missing — try clean reinstall
          await rm(nmDir, { recursive: true, force: true });
          const retryResult = await execCLI("npm", baseArgs, { cwd, timeout: 180_000 });
          const retryOutput = retryResult.stdout + "\n" + retryResult.stderr;
          const retryMatch = retryOutput.match(/added (\d+) packages?/);
          const retryCount = retryMatch ? parseInt(retryMatch[1]!, 10) : 0;
          if (retryResult.exitCode === 0 || retryCount > 0) {
            return successResponse(
              { installed: true, package_count: retryCount, cleaned_and_retried: true },
              `Dependencies installed successfully (${retryCount} packages, clean install).`
            );
          }
        }
      } catch {
        // node_modules doesn't exist at all
      }

      // Installation failed
      if (output.includes("ENOENT") || output.includes("no such file")) {
        return errorResponse(
          "NO_PACKAGE_JSON",
          `No package.json found in: ${cwd}`,
          "Ensure you are in a project directory with a package.json file. Use varity_init to create a new project."
        );
      }

      // ENOTEMPTY means npm tried to overwrite a broken/partial node_modules directory.
      // Auto-clean and retry once before surfacing an error.
      if (output.includes("ENOTEMPTY") || (output.includes("rename") && output.includes("node_modules"))) {
        try {
          await rm(resolve(cwd, "node_modules"), { recursive: true, force: true });
          const retryResult = await execCLI("npm", baseArgs, { cwd, timeout: 180_000 });
          const retryOutput = retryResult.stdout + "\n" + retryResult.stderr;
          if (retryResult.exitCode === 0) {
            const addedMatch = retryOutput.match(/added (\d+) packages?/);
            const packageCount = addedMatch ? parseInt(addedMatch[1]!, 10) : 0;
            return successResponse(
              { installed: true, package_count: packageCount, cleaned_broken_modules: true },
              `Cleaned broken node_modules and installed ${packageCount} packages successfully.`
            );
          }
        } catch {
          // Auto-clean failed — fall through to error response below
        }
        return errorResponse(
          "BROKEN_NODE_MODULES",
          "npm install failed because of a broken pre-installed node_modules directory.",
          "Fix by running: rm -rf node_modules && npm install"
        );
      }

      if (output.includes("ERESOLVE") || output.includes("peer dep")) {
        return errorResponse(
          "DEPENDENCY_CONFLICT",
          `Dependency conflict: ${output.substring(0, 500)}`,
          "Try running with --legacy-peer-deps or check for conflicting package versions."
        );
      }

      if (output.includes("ENOSPC") || output.includes("no space left on device")) {
        return errorResponse(
          "DISK_FULL",
          "npm install failed: the disk is full (no space left on device).",
          "Free up disk space and try again. Run `df -h` to see current disk usage."
        );
      }

      return errorResponse(
        "INSTALL_FAILED",
        `npm install failed:\n${output.substring(0, 800)}`,
        "Check the error above. Common causes: missing package.json, network issues, or insufficient disk space."
      );
    }
  );
}
