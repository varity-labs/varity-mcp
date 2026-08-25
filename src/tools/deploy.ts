import { z } from "zod";
import { access } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI, execVaritykit, isCLIAvailable, stripAnsi } from "../utils/cli-bridge.js";

/** Strip ANSI escape codes from CLI output before string matching. */
// eslint-disable-next-line no-control-regex
function extractPublicVarityUrl(output: string): string | null {
  const match = output.match(/https?:\/\/(?:[a-z0-9-]+\.)?varity\.app(?:\/[^\s"'<>)]*)?/i);
  return match?.[0] ?? null;
}

function cardSlugFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.endsWith(".varity.app")) {
      return url.hostname.slice(0, -".varity.app".length);
    }
    if (url.hostname === "varity.app") {
      return url.pathname.split("/").filter(Boolean)[0] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

export function registerDeployTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy",
    {
      title: "Deploy to Production",
      description:
        "Deploy the current project to production on Varity. " +
        "Detects the framework, selects the right hosting, and ships it live at https://varity.app/<name>/. " +
        "Zero configuration required. Paid apps bill up to a fixed monthly maximum for the reserved resources, prorated by running time; " +
        "for an unchanged profile, traffic alone does not change the price. Static sites are free for verified accounts. " +
        "Use this when a developer wants to deploy, publish, ship, or make their app live. " +
        "If the developer wants to deploy a certified template rather than their own code, " +
        "use varity_deploy_template instead. To stop a deployment and its billing, use varity_delete_deployment.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the project directory (e.g. '/home/user/my-app'). " +
            "IMPORTANT: always pass the full absolute path to the project root, the directory " +
            "that contains package.json and varity.config.json. " +
            "If omitted, the MCP server's working directory is used (which is rarely the correct project root). " +
            "Pass the absolute path to the project root (the directory that contains package.json)."
          ),
        repo_url: z
          .string()
          .optional()
          .describe(
            "GitHub repository URL for the app (e.g. 'https://github.com/user/my-app'). " +
            "Required for dynamic deployments. If omitted, auto-detected from .git/config. " +
            "Use the repo_url returned by varity_create_repo as the value here."
          ),
        app_name: z
          .string()
          .optional()
          .describe(
            "Custom app name that controls the deployment URL: https://varity.app/{app_name}/. " +
            "Must be URL-safe (lowercase letters, numbers, hyphens). " +
            "If omitted, the project directory name is used. " +
            "Use a different app_name than the directory to create named environments (staging, canary, etc.)."
          ),
        image: z
          .string()
          .optional()
          .describe(
            "Deploy a prebuilt Docker/OCI image directly (e.g. 'ghcr.io/you/app:latest') instead of " +
            "building from source. Use when the developer has a container image rather than a repo/project. " +
            "Mutually exclusive with repo_url."
          ),
        image_credentials: z
          .object({
            host: z.string().describe("registry host, e.g. ghcr.io or docker.io"),
            username: z.string(),
            password: z.string(),
          })
          .optional()
          .describe("Pull credentials for a PRIVATE image registry. Omit for public images."),
        port: z
          .number()
          .int()
          .optional()
          .describe("Container listen port for an --image deploy (default 80)."),
        volume_size: z
          .number()
          .int()
          .optional()
          .describe(
            "Persistent volume size in GB for the app container (survives restart/redeploy). " +
            "Use for stateful apps (databases, n8n, Ghost, etc.). Requires volume_path."
          ),
        volume_path: z
          .string()
          .optional()
          .describe(
            "Absolute container path to mount the persistent volume (e.g. '/data', '/home/node/.n8n'). " +
            "Requires volume_size."
          ),
      },
      annotations: {
        destructiveHint: true, // Deploys real infrastructure
      },
    },
    async ({ path, repo_url, app_name, image, image_credentials, port, volume_size, volume_path }) => {
      // Check if varitykit is installed, auto-install if missing
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

      // Pre-check Python version, varitykit requires 3.10+. Fail fast with an
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
              `  Fastest (pyenv, works on any machine):\n` +
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
          "Check the path and ensure the project directory exists and contains a package.json."
        );
      }

      // Pure passthrough to `varitykit app deploy`. The CLI and gateway are the
      // single hosting authority: framework detection, static-vs-dynamic hosting
      // selection, attached resources, and build handling all happen server-side.
      // The MCP asserts NO hosting opinion. It only forwards the
      // project path, the (optional) repo URL, and the (optional) app name.
      // `--mode auto` / `--hosting auto` are the CLI defaults, so we pass neither.
      const args = ["deploy"];
      if (repo_url) {
        args.push("--repo-url", repo_url);
      }
      if (image) {
        // Docker-image source: forward to the CLI, which routes it to the
        // gateway-owned image deployment path (no clone/build).
        args.push("--image", image);
        if (image_credentials) {
          args.push(
            "--image-registry", image_credentials.host,
            "--image-username", image_credentials.username,
            "--image-password", image_credentials.password,
          );
        }
        if (port) {
          args.push("--port", String(port));
        }
      }
      if (app_name) {
        args.push("--name", app_name);
      }
      // Persistent volume for the app container (Lane VOL). Pure passthrough to
      // the varitykit --volume-size/--volume-path flags (CLI 2.1.0+).
      if (volume_size != null) {
        args.push("--volume-size", String(volume_size));
      }
      if (volume_path) {
        args.push("--volume-path", volume_path);
      }

      const result = await execVaritykit("app", args, {
        cwd,
        timeout: 600_000,
      });

      if (result.exitCode === 0) {
        const output = stripAnsi(result.stdout + "\n" + result.stderr);

        const deployUrl = extractPublicVarityUrl(output) ?? "Check varity_deploy_status for the URL";
        const deploymentId = "unknown";
        const cardSlug = cardSlugFromUrl(deployUrl);
        const cardUrl = cardSlug ? `https://varity.app/card/${cardSlug}` : "";

        return successResponse(
          {
            url: deployUrl,
            deployment_id: deploymentId,
            status: "deployed",
            share_card: cardUrl || undefined,
            share_image: cardUrl ? `${cardUrl}/image.png` : undefined,
            next_steps: [
              `App live at: ${deployUrl}`,
              ...(cardUrl ? [`Share your deployment: ${cardUrl}`] : []),
              `Manage at: https://developer.store.varity.so`,
            ],
          },
          `Deployed successfully! Live at: ${deployUrl}${cardUrl ? ` | Share: ${cardUrl}` : ""}`
        );
      }

      // Deploy failed, parse error for helpful suggestion.
      // IMPORTANT: combine stdout+stderr. On failure, cli-bridge always sets stderr to at
      // minimum the Node error string ("Error: Command failed: ..."), so `stderr || stdout`
      // would silently discard stdout, which is where Python CLIs write their real errors.
      // Strip ANSI escape codes before string matching, Rich can emit them even with
      // FORCE_COLOR=0 because Python treats the string "0" as truthy.
      const output = stripAnsi((result.stdout || "") + "\n" + (result.stderr || ""));

      if (output.includes("No framework detected")) {
        return errorResponse(
          "NO_FRAMEWORK",
          `Could not detect a supported framework in: ${cwd}`,
          "Ensure you have a package.json with Next.js, React, or Vue. Pass the absolute path to your project root via the 'path' parameter (the directory that contains package.json and varity.config.json)."
        );
      }

      // "Aborted" means the varitykit process crashed, NOT a framework detection failure.
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
            ? `The deploy process was killed due to insufficient memory (exit code ${result.exitCode}). Build output:\n${output.slice(-2000)}`
            : `The deploy process crashed unexpectedly. Output:\n${output.slice(-2000)}`,
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
          "The varitykit CLI is installed but not working, Python cannot load it. This usually means Python 3.10+ is not active.",
          "1. Check Python version: python3 --version (need 3.10+)\n2. Run varity_doctor for detailed diagnosis and fix instructions\n3. After fixing Python, reinstall: pip install --upgrade varitykit"
        );
      }

      if (output.includes("build failed") || output.includes("Build error")) {
        return errorResponse(
          "BUILD_FAILED",
          `Build failed: ${output.slice(-2000)}`,
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
        `Deployment failed: ${output.slice(-2000)}`,
        "Check the error above. Common fixes: ensure dependencies are installed (run varity_install_deps), check for build errors (run varity_build for details)."
      );
    }
  );
}
