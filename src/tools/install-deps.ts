import { z } from "zod";
import { access, readdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI } from "../utils/cli-bridge.js";

// Returns names of framework binaries that are listed in package.json but absent or broken in .bin/
async function getMissingBinaries(cwd: string): Promise<string[]> {
  const missing: string[] = [];
  try {
    const pkg = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf-8"));
    const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const knownBins: [string, string][] = [
      ["next", "next"],
      ["vite", "vite"],
      ["react-scripts", "react-scripts"],
      ["typescript", "tsc"],
    ];
    for (const [dep, bin] of knownBins) {
      if (dep in deps) {
        const binPath = resolve(cwd, "node_modules", ".bin", bin);
        try {
          await access(binPath);
          // Detect zero-byte stubs, npm 10.9.3 can exit 0 while writing zero-byte placeholder
          // files instead of real binaries/symlinks. stat() follows symlinks so it checks the
          // actual binary target, catching both zero-byte files and zero-byte symlink targets.
          const s = await stat(binPath);
          if (s.size === 0) {
            missing.push(bin);
          }
        } catch {
          missing.push(bin);
        }
      }
    }
  } catch {
    // package.json unreadable or missing, skip verification
  }
  return missing;
}

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
          "Check the path and ensure the project directory exists and contains a package.json."
        );
      }

      // Python projects (FastAPI/Django/Flask) install via pip, not npm. Detect
      // pyproject.toml / requirements.txt first and short-circuit to pip.
      const hasPyproject = await access(resolve(cwd, "pyproject.toml")).then(() => true).catch(() => false);
      const hasRequirements = await access(resolve(cwd, "requirements.txt")).then(() => true).catch(() => false);
      if (hasPyproject || hasRequirements) {
        const pipArgs = hasPyproject ? ["install", "-e", "."] : ["install", "-r", "requirements.txt"];
        const py = await execCLI("pip", pipArgs, { cwd, timeout: 120_000 });
        if (py.exitCode === 0) {
          return successResponse(
            { framework: "python", installer: "pip" },
            "Python dependencies installed."
          );
        }
        return errorResponse(
          "PIP_INSTALL_FAILED",
          `pip install failed:\n${((py.stdout || "") + "\n" + (py.stderr || "")).slice(-2000)}`,
          "Ensure Python 3.10+ and pip are installed (run varity_doctor), then retry."
        );
      }

      // Proactively detect truly broken (empty) node_modules BEFORE npm runs.
      // Only remove if the directory is empty/near-empty, if real packages are present,
      // let npm do an incremental install rather than destroying good work.
      const nodeModulesPath = resolve(cwd, "node_modules");
      try {
        await access(nodeModulesPath);
        // node_modules exists, check for truly empty/broken state
        const nmEntries = await readdir(nodeModulesPath).catch(() => [] as string[]);
        if (nmEntries.length < 5) {
          // Near-empty, likely a broken partial install. Safe to remove.
          await rm(nodeModulesPath, { recursive: true, force: true });
        } else {
          // Substantial node_modules exists. Check if framework binaries are already
          // missing or zero-byte, if so, an incremental npm install won't regenerate
          // .bin/ entries for already-"installed" packages. Must clean first.
          const preexistingMissing = await getMissingBinaries(cwd);
          if (preexistingMissing.length > 0) {
            await rm(nodeModulesPath, { recursive: true, force: true });
          }
        }
      } catch {
        // node_modules doesn't exist, that's fine, npm install will create it
      }

      // Use --legacy-peer-deps to handle transitive dependency conflicts that cause npm to exit
      // non-zero even though packages install successfully.
      // --bin-links is explicit to override any environment .npmrc that sets no-bin-links=true,
      // which would cause npm to exit 0 while skipping .bin/ symlink creation entirely.
      const baseArgs = packages && packages.length > 0
        ? ["install", ...packages, "--bin-links"]
        : ["install", "--legacy-peer-deps", "--bin-links"];

      const result = await execCLI("npm", baseArgs, {
        cwd,
        timeout: 300_000, // 5 minutes
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

      // SUCCESS CHECK, Multiple signals, in priority order:
      // 1. Exit code 0 = definitive success
      // 2. "added N packages" in output = success even if exit code non-zero (peer dep warnings)
      // 3. node_modules/.bin/ has binaries = success (npm completed even if it complained)
      //
      // npm writes deprecation warnings to stderr even on success and sometimes
      // exits non-zero for peer dep conflicts that don't actually break anything.
      // NEVER treat warnings as errors.

      // Check 1: exit code
      if (result.exitCode === 0) {
        // Verify framework binaries exist even on a clean exit, npm can exit 0 when doing
        // an incremental install over a broken node_modules without regenerating missing .bin/
        // symlinks (e.g., pre-existing partial install, or no-bin-links in env .npmrc).
        const exitZeroMissingBins = await getMissingBinaries(cwd);
        if (exitZeroMissingBins.length > 0) {
          // npm exited 0 but framework binaries are missing, clean and do a full reinstall.
          try {
            await rm(resolve(cwd, "node_modules"), { recursive: true, force: true });
            const repairResult = await execCLI("npm", ["install", "--legacy-peer-deps", "--bin-links"], { cwd, timeout: 300_000 });
            if (repairResult.exitCode === 0) {
              const repairMissing = await getMissingBinaries(cwd);
              if (repairMissing.length === 0) {
                const repairOutput = repairResult.stdout + "\n" + repairResult.stderr;
                const repairAdded = repairOutput.match(/added (\d+) packages?/);
                const repairCount = repairAdded ? parseInt(repairAdded[1]!, 10) : 0;
                try {
                  await access(resolve(cwd, ".gitignore"));
                } catch {
                  try {
                    await writeFile(
                      resolve(cwd, ".gitignore"),
                      "node_modules\n.next\nout\n.env.local\n.env*.local\n.DS_Store\n",
                      "utf-8"
                    );
                  } catch { /* non-critical */ }
                }
                return successResponse(
                  { installed: true, package_count: repairCount, repaired_broken_install: true },
                  `Repaired incomplete installation and installed ${repairCount} packages successfully.`
                );
              }
            }
          } catch { /* fall through to error */ }
          return errorResponse(
            "MISSING_BINARIES",
            `npm install reported success but framework binaries are missing: ${exitZeroMissingBins.join(", ")}. The installation is incomplete.`,
            "Call varity_install_deps again to retry. If the issue persists, ensure Node.js v18+ is installed."
          );
        }

        // Create .gitignore if it doesn't exist, prevents node_modules from being committed
        try {
          const gitignorePath = resolve(cwd, ".gitignore");
          await access(gitignorePath);
        } catch {
          // .gitignore missing, create one
          try {
            await writeFile(
              resolve(cwd, ".gitignore"),
              "node_modules\n.next\nout\n.env.local\n.env*.local\n.DS_Store\n",
              "utf-8"
            );
          } catch { /* non-critical */ }
        }

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
                ? "Dependencies are up to date, nothing installed."
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

      // Check 3: node_modules/.bin/ has content, npm finished but output was truncated/buffered
      try {
        const binDir = resolve(cwd, "node_modules", ".bin");
        const binFiles = await readdir(binDir);
        if (binFiles.length > 0) {
          // Verify that framework binaries (e.g. .bin/next) are actually linked before
          // declaring success, a partial install can leave .bin/ non-empty but missing
          // the package's own binary entries.
          const missingBins = await getMissingBinaries(cwd);
          if (missingBins.length === 0) {
            return successResponse(
              { installed: true, package_count: binFiles.length, note: "Verified via installed binaries." },
              `Dependencies installed successfully (${binFiles.length} binaries available).`
            );
          }
          // missingBins.length > 0, fall through; auto-clean retry below will handle it
        }
      } catch {
        // .bin doesn't exist, fall through to error handling
      }

      // Check 4: node_modules has packages, treat as success (packages installed despite warnings)
      try {
        const nmDir = resolve(cwd, "node_modules");
        const nmContents = await readdir(nmDir);
        if (nmContents.length > 10) {
          const missingBins = await getMissingBinaries(cwd);
          if (missingBins.length === 0) {
            return successResponse(
              { installed: true, package_count: nmContents.length, note: "Dependencies installed (verified by package count). If you encounter 'module not found' errors, re-run varity_install_deps." },
              `Dependencies installed (${nmContents.length} packages found). Ready to develop.`
            );
          }
          // Framework binaries are missing despite node_modules having content, the install
          // ended before npm finished linking binaries. Auto-clean and retry once.
          try {
            await rm(resolve(cwd, "node_modules"), { recursive: true, force: true });
            const retryResult = await execCLI("npm", ["install", "--legacy-peer-deps", "--bin-links"], { cwd, timeout: 300_000 });
            if (retryResult.exitCode === 0) {
              const retryMissing = await getMissingBinaries(cwd);
              if (retryMissing.length === 0) {
                const retryAdded = (retryResult.stdout + retryResult.stderr).match(/added (\d+) packages?/);
                const retryCount = retryAdded ? parseInt(retryAdded[1]!, 10) : 0;
                return successResponse(
                  { installed: true, package_count: retryCount, repaired_broken_install: true },
                  `Repaired broken node_modules and installed ${retryCount} packages successfully.`
                );
              }
            }
          } catch {
            // Auto-repair failed, fall through to MISSING_BINARIES error
          }
          return errorResponse(
            "MISSING_BINARIES",
            `npm install completed but framework binaries are missing: ${missingBins.join(", ")}. node_modules is in a broken state.`,
            "Call varity_install_deps again to retry. If the issue persists, ensure Node.js v18+ is installed."
          );
        }
      } catch {
        // node_modules doesn't exist at all
      }

      // Installation failed
      if (output.includes("ENOENT") || output.includes("no such file")) {
        return errorResponse(
          "NO_PACKAGE_JSON",
          `No package.json found in: ${cwd}`,
          "Ensure you are in a project directory with a package.json file."
        );
      }

      // ENOTEMPTY means npm tried to overwrite a broken/partial node_modules directory.
      // Auto-clean and retry once before surfacing an error.
      if (output.includes("ENOTEMPTY") || (output.includes("rename") && output.includes("node_modules"))) {
        try {
          await rm(resolve(cwd, "node_modules"), { recursive: true, force: true });
          // Always do a FULL install after wiping node_modules, even if the original call
          // was for specific packages. Deleting node_modules removes everything; a
          // packages-only retry (baseArgs) would leave the project missing its base deps.
          const retryResult = await execCLI("npm", ["install", "--legacy-peer-deps", "--bin-links"], { cwd, timeout: 300_000 });
          const retryOutput = retryResult.stdout + "\n" + retryResult.stderr;
          if (retryResult.exitCode === 0) {
            const retryMissing = await getMissingBinaries(cwd);
            if (retryMissing.length > 0) {
              return errorResponse(
                "MISSING_BINARIES",
                `Cleaned and reinstalled, but framework binaries are still missing: ${retryMissing.join(", ")}.`,
                "Call varity_install_deps again to retry. If the issue persists, ensure Node.js v18+ is installed."
              );
            }
            const addedMatch = retryOutput.match(/added (\d+) packages?/);
            const packageCount = addedMatch ? parseInt(addedMatch[1]!, 10) : 0;
            return successResponse(
              { installed: true, package_count: packageCount, cleaned_broken_modules: true },
              `Cleaned broken node_modules and installed ${packageCount} packages successfully.`
            );
          }
        } catch {
          // Auto-clean failed, fall through to error response below
        }
        return errorResponse(
          "BROKEN_NODE_MODULES",
          "npm install failed because of a broken pre-installed node_modules directory.",
          "Call varity_install_deps again to retry. If the issue persists, ensure Node.js v18+ is installed."
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
