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

/** Return true if the project is a Next.js static export (output: 'export'). */
async function isStaticExport(cwd: string): Promise<boolean> {
  try {
    const cfg = await readFile(resolve(cwd, "next.config.js"), "utf-8");
    return cfg.includes("output: 'export'") || cfg.includes('output: "export"');
  } catch {
    try {
      const cfg = await readFile(resolve(cwd, "next.config.ts"), "utf-8");
      return cfg.includes("output: 'export'") || cfg.includes('output: "export"');
    } catch {
      return false;
    }
  }
}

/**
 * Detect the deployable output directory based on framework and config.
 * For Next.js static exports, `out/` is the deployable artifact.
 * `.next/` is an intermediate build cache, not the deployable output.
 */
async function detectOutputDir(cwd: string): Promise<{ dir: string; isDeployable: boolean } | null> {
  // For Next.js static export: deployable output is `out/`, not `.next/`
  const staticExport = await isStaticExport(cwd);
  if (staticExport) {
    if (await dirExists(resolve(cwd, "out"))) {
      return { dir: "out", isDeployable: true };
    }
    // Build ran but out/ not yet created — check .next/ as fallback
    if (await dirExists(resolve(cwd, ".next"))) {
      return { dir: ".next", isDeployable: false };
    }
  }

  // Non-static-export: check common output dirs
  const candidates = [".next", "dist", "build", "out"];
  for (const dir of candidates) {
    if (await dirExists(resolve(cwd, dir))) {
      return { dir, isDeployable: true };
    }
  }
  return null;
}

/**
 * Parse Next.js build output for routes whose "First Load JS" exceeds
 * the given threshold in KB (default 500 KB).
 *
 * Next.js route lines look like:
 *   ┌ ○ /dashboard    5.18 kB    93.4 kB
 * The SECOND size value is the "First Load JS" (total JS the browser downloads).
 */
function parseLargeBundles(
  output: string,
  thresholdKb = 500
): Array<{ route: string; firstLoadKb: number; label: string }> {
  const large: Array<{ route: string; firstLoadKb: number; label: string }> = [];
  // Box-drawing chars used by Next.js: ┌ ├ └ │
  const routeLineRe =
    /^[┌├└│]\s+[○●◐λƒ✓✗]\s+(\S+)\s+[\d.]+\s+(?:B|kB|MB)\s+([\d.]+)\s+(B|kB|MB)/;
  for (const line of output.split("\n")) {
    const m = routeLineRe.exec(line);
    if (!m) continue;
    const route = m[1]!;
    const size = parseFloat(m[2]!);
    const unit = m[3]!;
    const kb =
      unit === "MB" ? size * 1024 : unit === "B" ? size / 1024 : size;
    if (kb > thresholdKb) {
      large.push({
        route,
        firstLoadKb: Math.round(kb),
        label: `${size} ${unit}`,
      });
    }
  }
  return large;
}

/**
 * Parse build time (seconds) from Next.js output.
 * Next.js reports: "Compiled successfully in X.Xs" or "✓ Compiled ... in X.Xs"
 * and at the end: "Route (app) ... [X.Xs]" style lines.
 */
function parseBuildTime(output: string): number | null {
  // Match "in X.Xs" pattern (Next.js 14/15 style)
  const match = output.match(/[Cc]ompiled.*?in\s+([\d.]+)s/);
  if (match) return parseFloat(match[1]!);
  // Match "Finished in X.Xs" (some Next.js variants)
  const match2 = output.match(/[Ff]inished in\s+([\d.]+)s/);
  if (match2) return parseFloat(match2[1]!);
  return null;
}

/**
 * Parse build output size from Next.js route table.
 * The shared First Load JS size appears at the bottom: "+ First Load JS shared by all  102 kB"
 */
function parseBuildSize(output: string): string | null {
  // "First Load JS shared by all  102 kB" or "102 kB"
  const match = output.match(/First Load JS shared by all\s+([\d.]+\s*(?:kB|MB|B))/i);
  if (match) return match[1]!.trim();
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
      trimmed.includes("Cannot find module") ||
      // Shell "command not found" when a framework binary is missing from .bin/
      ((trimmed.startsWith("sh:") || trimmed.startsWith("bash:") || trimmed.startsWith("zsh:")) && trimmed.includes("not found")) ||
      // npm ENOENT when spawning a missing binary (e.g. "npm error enoent spawn next ENOENT")
      (trimmed.startsWith("npm error") && trimmed.toLowerCase().includes("enoent"))
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
          // For server apps (Express, Fastify, etc.) no build step is needed — just verify the entry point exists
          const mainFile = pkg.main || "server.js";
          try {
            await access(`${cwd}/${mainFile}`);
            return successResponse({
              deployable_output: true,
              framework: "nodejs",
              entry_point: mainFile,
              note: "This is a server application. Use varity_deploy to deploy it directly."
            }, `Server app detected (${mainFile}) — no build step needed. Ready to deploy.`);
          } catch {
            return errorResponse(
              "NO_BUILD_SCRIPT",
              'No "build" script found in package.json and no server entry point detected.',
              'Add a build script (e.g., "build": "next build") or ensure server.js/index.js exists.'
            );
          }
        }
      } catch {
        // Python projects legitimately have no package.json — build is not needed
        const pythonIndicators = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "setup.cfg"];
        for (const indicator of pythonIndicators) {
          try {
            await access(resolve(cwd, indicator));
            return successResponse(
              { deployable_output: true, framework: "python", build_needed: false },
              "Python project detected — no build step needed. Use varity_deploy to deploy directly."
            );
          } catch { /* not found, try next */ }
        }
        return errorResponse(
          "NO_PACKAGE_JSON",
          `No package.json found in: ${cwd}`,
          "Ensure you are in a project directory with a package.json file. Use varity_init to create a new project."
        );
      }

      // Detect missing node_modules before running — produces a clear error instead of
      // the confusing "sh: next: not found" that parseBuildErrors won't recognize.
      try {
        await access(resolve(cwd, "node_modules"));
      } catch {
        return errorResponse(
          "MISSING_NODE_MODULES",
          `node_modules is missing in: ${cwd}. Dependencies have not been installed.`,
          "Run varity_install_deps first to install dependencies, then try building again."
        );
      }

      const result = await execCLI("npm", ["run", "build"], {
        cwd,
        timeout: 300_000, // 5 minutes
        // Increase Node.js heap to 4 GB to avoid OOM kills on large dependency trees
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
      });

      const output = result.stdout + "\n" + result.stderr;
      const errors = parseBuildErrors(output);

      if (result.exitCode === 0) {
        const outputInfo = await detectOutputDir(cwd);

        // Parse build metrics from Next.js output
        const buildTimeSeconds = parseBuildTime(output);
        const buildSize = parseBuildSize(output);

        // Check for large bundles (First Load JS > 500 KB)
        const largeBundles = parseLargeBundles(output);
        const bundleWarnings = largeBundles.map(
          (b) =>
            `ℹ ${b.route}: First Load JS is ${b.label}. For Varity dashboard apps, bundles up to ~700 kB are expected — the auth and UI framework account for most of this. Next.js code-splits per route so users only download what each page needs. No action required.`
        );

        // Determine the right message based on output type
        let successMsg: string;
        if (outputInfo?.dir === "out") {
          successMsg = `Build succeeded! Deployable output in out/. Run varity_deploy to deploy.`;
        } else if (outputInfo?.dir === ".next" && !outputInfo.isDeployable) {
          successMsg = `TypeScript compilation succeeded (.next/ created). Static export (out/) was not produced — this may indicate an issue with output: 'export' configuration. Run varity_deploy to attempt a full deploy.`;
        } else if (outputInfo) {
          successMsg = `Build succeeded! Output in ${outputInfo.dir}/. Run varity_deploy to deploy.`;
        } else {
          successMsg = `Build compilation succeeded. Run varity_deploy to deploy.`;
        }

        if (buildTimeSeconds !== null) {
          successMsg += ` Build time: ${buildTimeSeconds.toFixed(1)}s.`;
        }

        if (bundleWarnings.length > 0) {
          successMsg += `\n\nBundle size warnings (${bundleWarnings.length}):\n${bundleWarnings.join("\n")}`;
        }

        return successResponse(
          {
            success: true,
            output_dir: outputInfo?.dir ?? null,
            deployable_output: outputInfo?.isDeployable ?? false,
            ...(buildTimeSeconds !== null && { build_time_seconds: buildTimeSeconds }),
            ...(buildSize !== null && { build_size: buildSize }),
            errors: [],
            bundle_warnings: bundleWarnings,
          },
          successMsg
        );
      }

      // Build failed — always include the raw tail of output so the developer
      // can see the actual failure reason (OOM kill, TypeScript error, missing import, etc.)
      const rawTail = output.slice(-2000);
      const errorSummary =
        errors.length > 0
          ? `Build failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${errors.slice(0, 10).join("\n")}\n\nFull build output:\n${rawTail}`
          : `Build failed:\n${rawTail}`;

      // Context-aware fix suggestion based on error type
      const fixSuggestion =
        errors.some((e) =>
          ((e.startsWith("sh:") || e.startsWith("bash:") || e.startsWith("zsh:")) && e.includes("not found")) ||
          (e.startsWith("npm error") && e.toLowerCase().includes("enoent"))
        )
        ? "A framework binary is missing from node_modules/.bin. Run varity_install_deps to reinstall all dependencies, then try building again."
        : errors.some((e) => e.includes("Cannot find module") || e.includes("Module not found"))
          ? (
              // @tanstack/react-query is a peer dep of wagmi (via ui-kit) that npm sometimes
              // hoists into ui-kit/node_modules instead of the top-level. Install it explicitly.
              output.includes("@tanstack/react-query") || output.includes("react-query")
                ? "A required peer dependency is missing. Call `varity_install_deps({ packages: ['@tanstack/react-query'] })` to install it, then try building again."
                : "A required dependency is missing. Call `varity_install_deps` to reinstall all dependencies, then try building again. If the error persists, ensure your next.config.js has the resolve.alias stubs from the Varity template (run varity_init to get the correct config)."
            )
          : errors.some((e) => e.includes("Type error") || e.includes("TypeScript"))
          ? (
              // Detect the specific cast pattern generated by varity_add_collection for FK reference fields.
              // TypeScript 5 rejects `(item as Record<string, string>)` when the item type has non-string fields.
              // The fix is a one-liner: replace the cast with `(item as any)`.
              errors.some((e) => e.includes("Conversion of type") || output.includes("Conversion of type") || output.includes("Record<string, string>"))
                ? "TypeScript type error in a generated page. This is caused by a known codegen pattern in varity_add_collection. To fix:\n" +
                  "  In the failing file, find any line with '(item as Record<string, string>)'\n" +
                  "  Replace it with: (item as any)\n" +
                  "  Example:\n" +
                  "    Before: (item as Record<string, string>).name ?? ...\n" +
                  "    After:  (item as any).name ?? ...\n" +
                  "  The generated page should compile after this one-line fix."
                : "Fix the TypeScript errors shown above, then try building again."
            )
          : output.includes("Permission denied") || output.includes("EACCES")
          ? "A file permission error occurred — the Next.js binary may not be executable. Fix by running: rm -rf node_modules && npm install, then try building again."
          : output.includes("ENOSPC") || output.includes("no space left")
          ? "The build failed because the disk is full. Free up disk space (run `df -h` to check) and try again."
          : output.includes("Killed") || output.includes("out of memory") || output.includes("heap out of memory")
          ? "The build ran out of memory. Close other applications to free RAM, then try again."
          : "Fix the errors above and try building again.";

      return errorResponse("BUILD_FAILED", errorSummary, fixSuggestion);
    }
  );
}
