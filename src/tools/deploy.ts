import { z } from "zod";
import { readdir, readFile, access, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, execVaritykit, isCLIAvailable } from "../utils/cli-bridge.js";
import { getDeploymentsDir } from "../utils/config.js";

/** Save build output as a log file so varity_deploy_logs can show real content. */
async function saveBuildLog(deploymentId: string, buildOutput: string): Promise<void> {
  try {
    const deploymentsDir = getDeploymentsDir();
    await mkdir(deploymentsDir, { recursive: true });
    await writeFile(join(deploymentsDir, `${deploymentId}.log`), buildOutput, "utf-8");
  } catch {
    // Non-critical — don't fail deploy if log write fails
  }
}

export function registerDeployTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy",
    {
      title: "Deploy to Production",
      description:
        "Deploy the current project to production on Varity infrastructure. " +
        "Automatically detects framework (Next.js, React, Vue), builds the project, and deploys it. " +
        "Returns a live URL. The deployed app automatically gets a production database, " +
        "authentication, and payment processing — zero configuration required. " +
        "Cost: ~70% less than AWS/Vercel. " +
        "Use this when a developer wants to deploy, publish, ship, or make their app live.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the project directory (e.g. '/home/user/my-app'). " +
            "IMPORTANT: always pass the full absolute path to the project root — the directory " +
            "that contains package.json and varity.config.json. " +
            "If omitted, the MCP server's working directory is used (which is rarely the correct project root). " +
            "Use the project_path returned by varity_init as the value here."
          ),
        submit_to_store: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Also submit the app to the Varity App Store for monetization (90% revenue to developer)"
          ),
        repo_url: z
          .string()
          .optional()
          .describe(
            "GitHub repository URL for the app (e.g. 'https://github.com/user/my-app'). " +
            "Required for dynamic (Akash) deployments. If omitted, auto-detected from .git/config. " +
            "Use the repo_url returned by varity_create_repo as the value here."
          ),
      },
      annotations: {
        destructiveHint: true, // Deploys real infrastructure
      },
    },
    async ({ path, submit_to_store, repo_url }) => {
      // Check if varitykit is installed — auto-install if missing
      let hasVaritykit = await isCLIAvailable("varitykit");
      if (!hasVaritykit) {
        // Attempt automatic installation via pip
        const pipInstall = await (async () => {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          try {
            await execFileAsync("pip", ["install", "varitykit"], {
              timeout: 60_000,
              env: { ...process.env },
            });
            return true;
          } catch {
            return false;
          }
        })();

        if (pipInstall) {
          hasVaritykit = await isCLIAvailable("varitykit");
        }

        if (!hasVaritykit) {
          return errorResponse(
            "CLI_NOT_INSTALLED",
            "The varitykit CLI is not installed and automatic installation failed. It's required for deployment.",
            "Install it manually with: pip install varitykit  OR  pip3 install varitykit"
          );
        }
      }

      // Pre-check Python version — varitykit requires 3.10+. Fail fast with an
      // actionable message rather than letting varitykit crash with a confusing
      // traceback (ImportError / SyntaxError).
      {
        const pyCmd = process.platform === "win32" ? "python" : "python3";
        const pyCheck = await execCLI(pyCmd, ["--version"], { timeout: 5_000 });
        if (pyCheck.exitCode === 0 && pyCheck.stdout) {
          const verMatch = pyCheck.stdout.trim().match(/Python\s+(\d+)\.(\d+)/i);
          const pyMajor = verMatch ? parseInt(verMatch[1]!, 10) : null;
          const pyMinor = verMatch ? parseInt(verMatch[2]!, 10) : null;
          const meetsReq =
            pyMajor !== null &&
            pyMinor !== null &&
            (pyMajor > 3 || (pyMajor === 3 && pyMinor >= 10));
          if (!meetsReq) {
            const detected = pyCheck.stdout.trim();
            return errorResponse(
              "PYTHON_VERSION_REQUIRED",
              `Deployment requires Python 3.10+ but ${detected} was detected. varitykit (the Varity deploy CLI) requires Python 3.10 or higher.`,
              `Fix: upgrade Python to 3.10+ using one of these methods:\n\n` +
              `  Fastest (pyenv — works on any machine):\n` +
              `    curl https://pyenv.run | bash\n` +
              `    pyenv install 3.11\n` +
              `    pyenv global 3.11\n\n` +
              `  macOS (Homebrew):\n` +
              `    brew install python@3.11\n\n` +
              `  Windows / direct download:\n` +
              `    https://python.org/downloads  (pick 3.11 or 3.12)\n\n` +
              `After upgrading, run varity_doctor to confirm everything is ready, then try deploying again.`
            );
          }
        }
        // If Python is not detectable, let varitykit surface the error naturally
      }

      const cwd = path || process.cwd();

      // Validate that the project directory exists before attempting deploy
      try {
        await access(cwd);
      } catch {
        return errorResponse(
          "PATH_NOT_FOUND",
          `Project directory does not exist: ${cwd}`,
          "Check the path and ensure the project has been created (use varity_init first)."
        );
      }

      // Auto-build before deploying
      let buildSkipped = true;
      // Capture build output so we can save it as a log after deploy succeeds
      let capturedBuildOutput = "";
      try {
        const pkgRaw = await readFile(`${cwd}/package.json`, "utf-8");
        const pkg = JSON.parse(pkgRaw);
        if (pkg.scripts?.build) {
          buildSkipped = false;
          const buildResult = await execCLI("npm", ["run", "build"], {
            cwd,
            timeout: 300_000,
            // Increase Node.js heap to 4 GB to avoid OOM kills on large dependency trees
            env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
          });
          // Capture full build output for log saving regardless of success/failure
          capturedBuildOutput = (buildResult.stdout || "") + "\n" + (buildResult.stderr || "");

          if (buildResult.exitCode !== 0) {
            const rawTail = capturedBuildOutput.slice(-2000);
            // Save failed build log so varity_deploy_logs can show it
            await saveBuildLog(`build-failed-${Date.now()}`, capturedBuildOutput);
            const fixHint =
              capturedBuildOutput.includes("Killed") || capturedBuildOutput.includes("out of memory") || capturedBuildOutput.includes("heap out of memory")
                ? "The build ran out of memory. To fix:\n1. Close other applications to free RAM and try again.\n2. Set NODE_OPTIONS=--max-old-space-size=2048 in your terminal environment before deploying.\n3. In a cloud IDE or container: upgrade to a larger instance type (Next.js builds need ~2 GB free RAM)."
                : (capturedBuildOutput.includes("PageNotFoundError") || capturedBuildOutput.includes("Cannot find module for page"))
                ? "Clear your Next.js build cache: rm -rf .next, then try deploying again. This happens when a previous build was interrupted. Also run varity_install_deps to ensure all dependencies are installed."
                : (capturedBuildOutput.includes("Cannot find module") || capturedBuildOutput.includes("Module not found")) && !capturedBuildOutput.includes("for page")
                ? "A required dependency is missing. Run: npm install --legacy-peer-deps in your project directory, then try deploying again. If your next.config.js is missing the resolve.alias stubs, recreate it from a fresh varity_init project."
                : capturedBuildOutput.includes("Type error") || capturedBuildOutput.includes("TypeScript")
                ? "Fix the TypeScript errors shown above, then try deploying again."
                : "Check the build errors above, fix them, and try deploying again.";
            return errorResponse(
              "BUILD_FAILED",
              `Local build failed before deploy. Build output:\n${rawTail}`,
              fixHint
            );
          }
        }
      } catch (err: unknown) {
        const isFileError = err instanceof Error && 'code' in err && (err as any).code === 'ENOENT';
        const isParseError = err instanceof SyntaxError;
        if (!isFileError && !isParseError) {
          throw err;
        }
      }

      const args = ["deploy", "--mode", "auto"];

      // Pre-detect framework from package.json to avoid varitykit's internal detection failing.
      // This ensures projects scaffolded by varity_init always deploy successfully.
      let detectedHosting: "static" | "dynamic" | "unknown" = "unknown";
      let orchestrationSummary = "Hosting: Auto-detected";
      try {
        const pkgForDeploy = JSON.parse(await readFile(`${cwd}/package.json`, "utf-8"));
        const deps = { ...pkgForDeploy.dependencies, ...pkgForDeploy.devDependencies };
        // Detect server frameworks → dynamic (Akash)
        const dynamicFrameworks = ["express", "fastify", "@nestjs/core", "koa", "hapi", "hono"];
        const hasDynamicFramework = dynamicFrameworks.some(f => f in deps);

        if (hasDynamicFramework) {
          // Server framework detected — always dynamic (Akash)
          detectedHosting = "dynamic";
          orchestrationSummary = "Detected: Dynamic app → Hosting: Cloud compute (Akash — auto-configured with database)";
        } else if ("next" in deps) {
          // Next.js — check if static export or dynamic
          let isStatic = false;
          try {
            const nextCfg = await readFile(`${cwd}/next.config.js`, "utf-8");
            isStatic = nextCfg.includes("output: 'export'") || nextCfg.includes('output: "export"');
          } catch {
            // No next.config.js — assume dynamic (Akash)
          }
          detectedHosting = isStatic ? "static" : "dynamic";
          orchestrationSummary = isStatic
            ? "Detected: Next.js static app → Hosting: Global CDN"
            : "Detected: Dynamic Next.js app → Hosting: Cloud compute (Akash — auto-configured with database)";
        } else {
          // Unknown framework — default to dynamic (Akash) for custom apps
          detectedHosting = "dynamic";
          orchestrationSummary = "Detected: Custom app → Hosting: Cloud compute (Akash — auto-configured with database)";
          args.push("--hosting", detectedHosting);
          // For dynamic (Akash) deployments, resolve and pass the GitHub repo URL
          if (detectedHosting === "dynamic") {
            // Resolve repo URL: explicit param > .git/config auto-detect
            let resolvedRepoUrl = repo_url || "";
            if (!resolvedRepoUrl) {
              const gitRemoteResult = await execCLI("git", ["remote", "get-url", "origin"], { cwd, timeout: 5000 });
              if (gitRemoteResult.exitCode === 0 && gitRemoteResult.stdout.trim()) {
                resolvedRepoUrl = gitRemoteResult.stdout.trim();
              }
            }
            if (resolvedRepoUrl) {
              // Pass repo URL to CLI AND write to config as fallback
              args.push("--repo-url", resolvedRepoUrl);
              try {
                const configPath = `${cwd}/varity.config.json`;
                let config: Record<string, unknown> = {};
                try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* new config */ }
                config.github_repo = resolvedRepoUrl;
                await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
              } catch { /* non-critical */ }
            } else {
              orchestrationSummary += " | ⚠️ No GitHub repo detected — create one first with varity_create_repo";
            }
          }
        }
      } catch {
        // Can't read package.json — let varitykit detect
      }

      // If the MCP already ran a successful build above, tell varitykit to skip its own build.
      // This prevents a redundant second build (which can OOM on memory-constrained machines)
      // and speeds up deploys significantly. varitykit uploads the existing build output directly.
      if (!buildSkipped) {
        args.push("--skip-build");
      }

      // For dynamic hosting (Akash): push the locally-built output to the GitHub repo
      // so the Akash container can git clone and run `npm start` without rebuilding.
      // This is critical — building inside the Akash container is slow and fragile.
      if (detectedHosting === "dynamic" && !buildSkipped) {
        try {
          // Check if this is a git repo with a remote
          const gitRemote = await execCLI("git", ["remote", "get-url", "origin"], { cwd, timeout: 5000 });
          if (gitRemote.exitCode === 0 && gitRemote.stdout.trim()) {
            // Add the build output (.next/) and commit
            await execCLI("git", ["add", "-A"], { cwd, timeout: 10000 });
            const commitResult = await execCLI("git", ["commit", "-m", "Build output for deployment", "--allow-empty"], { cwd, timeout: 10000 });
            if (commitResult.exitCode === 0) {
              const pushResult = await execCLI("git", ["push", "origin", "main"], { cwd, timeout: 30000 });
              if (pushResult.exitCode !== 0) {
                // Try pushing to master if main doesn't exist
                await execCLI("git", ["push", "origin", "master"], { cwd, timeout: 30000 });
              }
            }
          }
        } catch {
          // Git push failed — continue with deploy anyway, Akash will build from source
        }
      }

      if (submit_to_store) {
        args.push("--submit-to-store");
        args.push("--tier", "free");
      }

      const result = await execVaritykit("app", args, {
        cwd,
        timeout: 300_000, // 5 minutes for upload + deploy (no rebuild needed)
      });

      if (result.exitCode === 0) {
        // Parse deploy output for URL and metadata
        const output = result.stdout + "\n" + result.stderr;

        // Try to read the latest deployment record (most reliable source of URL)
        let deployUrl = "unknown";
        let buildSize = "unknown";
        let fileCount = "unknown";
        let deploymentId = "unknown";

        let ipfsUrl: string | undefined;
        try {
          const deploymentsDir = getDeploymentsDir();
          const files = await readdir(deploymentsDir);
          const jsonFiles = files.filter((f) => f.endsWith(".json")).sort().reverse();
          if (jsonFiles.length > 0) {
            const latest = JSON.parse(
              await readFile(`${deploymentsDir}/${jsonFiles[0]}`, "utf-8")
            );
            // Prefer the clean varity.app custom domain URL over raw provider URLs
            const rawUrl =
              latest.custom_domain?.url ||
              latest.akash?.url ||
              latest.url ||
              latest.ipfs?.gateway_url ||
              "unknown";

            // If the resolved URL is a raw storage hash, construct a clean varity.app URL
            const isRawIpfs =
              rawUrl.includes("ipfs.io/ipfs/") ||
              rawUrl.includes("ipfscdn.");
            if (isRawIpfs) {
              ipfsUrl = rawUrl; // preserve as secondary
              // Source the app slug from the deployment record first
              const subdomain =
                latest.custom_domain?.subdomain ||
                latest.app_name ||
                latest.project_name;
              if (subdomain) {
                deployUrl = `https://varity.app/${subdomain}/`;
              } else {
                // Fall back to reading the project's package.json name
                try {
                  const pkgJson = JSON.parse(await readFile(`${cwd}/package.json`, "utf-8"));
                  const pkgName: string | undefined = pkgJson.name;
                  if (pkgName) {
                    deployUrl = `https://varity.app/${pkgName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}/`;
                  } else {
                    deployUrl = rawUrl;
                  }
                } catch {
                  deployUrl = rawUrl;
                }
              }
            } else {
              deployUrl = rawUrl;
            }

            buildSize = latest.build?.size_mb
              ? `${latest.build.size_mb.toFixed(1)} MB`
              : "unknown";
            fileCount = String(latest.build?.files ?? latest.ipfs?.file_count ?? "unknown");
            deploymentId = latest.deployment_id || jsonFiles[0]!.replace(".json", "");
            // Save the build log so varity_deploy_logs can show real output
            if (capturedBuildOutput && deploymentId !== "unknown") {
              await saveBuildLog(deploymentId, capturedBuildOutput);
            }
          }
        } catch {
          // Fallback to regex parsing of CLI output
          const urlMatch = output.match(
            /https?:\/\/[^\s]+\.(?:varity\.app|ipfs\.\S+|ipfscdn\.\S+|gateway\.\S+)/i
          );
          deployUrl = urlMatch?.[0] ?? "Check varity_deploy_status for the URL";
        }

        // Build card URL from deploy URL if it's on varity.app
        let cardUrl = "";
        const varityMatch = deployUrl.match(/varity\.app\/([^/\s]+)/);
        if (varityMatch) {
          cardUrl = `https://varity.app/card/${varityMatch[1]}`;
        }

        return successResponse(
          {
            url: deployUrl,
            deployment_id: deploymentId,
            status: "deployed",
            build_size: buildSize,
            files: fileCount,
            store_listing: submit_to_store ? "submitted" : "not_submitted",
            share_card: cardUrl || undefined,
            share_image: cardUrl ? `${cardUrl}/image.png` : undefined,
            orchestration: orchestrationSummary,
            infrastructure: {
              hosting: detectedHosting === "static" ? "Global CDN — served from 30+ edge locations worldwide (auto-selected)" : detectedHosting === "dynamic" ? "Cloud compute — dedicated CPU/RAM on distributed providers (auto-selected)" : "Varity (auto-selected)",
              database: "Document database (included)",
              auth: "Authentication (included)",
            },
            build_note: !buildSkipped
              ? "Note: varity_deploy ran npm run build internally to produce the exact artifact uploaded to production. If you also ran varity_build separately, that earlier build was a local verification step — the deploy's own build is what's live."
              : undefined,
            next_steps: submit_to_store
              ? [
                  `App live at: ${deployUrl}`,
                  "App submitted to Varity App Store",
                  "Revenue split: 90% to you, 10% platform fee",
                  ...(cardUrl ? [`Share your deployment: ${cardUrl}`] : []),
                  "Note: your deployed app uses local project files. If you created a GitHub repo with varity_create_repo, push your code to sync it: git push origin main",
                ]
              : [
                  `App live at: ${deployUrl}`,
                  ...(cardUrl ? [`Share your deployment: ${cardUrl}`] : []),
                  "To monetize: run deploy again with submit_to_store=true",
                  `Or visit: https://developer.store.varity.so`,
                  "Note: your deployed app uses local project files. If you created a GitHub repo with varity_create_repo, push your code to sync it: git push origin main",
                ],
          },
          `Deployed successfully! ${orchestrationSummary}. Live at: ${deployUrl}${cardUrl ? ` | Share: ${cardUrl}` : ""}`
        );
      }

      // Deploy failed — parse error for helpful suggestion
      const output = result.stderr || result.stdout;

      if (output.includes("No framework detected")) {
        return errorResponse(
          "NO_FRAMEWORK",
          `Could not detect a supported framework in: ${cwd}`,
          "Ensure you have a package.json with Next.js, React, or Vue. Pass the absolute path to your project root via the 'path' parameter (the directory that contains package.json and varity.config.json)."
        );
      }

      // "Aborted" means the varitykit process crashed — NOT a framework detection failure.
      // Common causes: OOM during build, Python error, missing dep. Give a specific hint.
      if (output.includes("Aborted") || result.exitCode === 137) {
        const isOom =
          output.includes("Killed") ||
          output.includes("out of memory") ||
          output.includes("heap out of memory") ||
          result.exitCode === 137;
        return errorResponse(
          isOom ? "BUILD_OOM" : "DEPLOY_CRASHED",
          isOom
            ? `The deploy process was killed due to insufficient memory (exit code ${result.exitCode}). Build output:\n${output.slice(-500)}`
            : `The deploy process crashed unexpectedly. Output:\n${output.slice(-500)}`,
          isOom
            ? "Not enough free RAM for the deploy process. To fix:\n" +
              "1. Free up RAM by closing other applications.\n" +
              "2. Or upgrade to a larger machine/instance type (Next.js builds need ~2 GB free RAM).\n" +
              "3. If running in a cloud IDE or CI: set NODE_OPTIONS=--max-old-space-size=2048 in your environment before deploying."
            : "Run varity_doctor to check your environment. If varitykit is broken, reinstall with: pip install --upgrade varitykit"
        );
      }

      if (output.includes("PageNotFoundError") || output.includes("Cannot find module for page")) {
        return errorResponse(
          "NEXTJS_PAGE_ERROR",
          `Deployment failed: Next.js could not find a required page module.\n\n${output.substring(0, 500)}`,
          "Clear your Next.js build cache: rm -rf .next, then try deploying again. This happens when a previous build was interrupted. Steps to fix:\n1. Run: rm -rf .next\n2. Run varity_install_deps to ensure all dependencies are installed\n3. Ensure next.config.js has: output: 'export', images: { unoptimized: true }, trailingSlash: true\n4. Try deploying again"
        );
      }

      // Detect broken Python CLI installation (ImportError, ModuleNotFoundError, etc.)
      // This happens when varitykit is installed but the package itself is corrupt or
      // its dependencies are missing. isCLIAvailable() returns true (the binary exists)
      // but the CLI crashes on import with a Python traceback.
      if (
        output.includes("ImportError") ||
        output.includes("ModuleNotFoundError") ||
        output.includes("cannot import name") ||
        output.includes("No module named") ||
        output.includes("SyntaxError")
      ) {
        return errorResponse(
          "CLI_BROKEN",
          "The varitykit CLI is installed but not working — Python cannot load it. This usually means Python 3.10+ is not active.",
          "1. Check Python version: python3 --version (need 3.10+)\n2. Run varity_doctor for detailed diagnosis and fix instructions\n3. After fixing Python, reinstall: pip install --upgrade varitykit"
        );
      }

      if (output.includes("build failed") || output.includes("Build error")) {
        return errorResponse(
          "BUILD_FAILED",
          `Build failed: ${output.substring(0, 500)}`,
          "Fix the build errors shown above, then try deploying again."
        );
      }

      if (output.includes("ENOENT") || output.includes("no such file")) {
        return errorResponse(
          "PATH_NOT_FOUND",
          `Project directory not found: ${cwd}`,
          "Check the path and ensure the project directory exists."
        );
      }

      return errorResponse(
        "DEPLOY_FAILED",
        `Deployment failed: ${output.substring(0, 500)}`,
        "Check the error above. Common fixes: ensure dependencies are installed (run varity_install_deps), check for build errors (run varity_build for details)."
      );
    }
  );
}
