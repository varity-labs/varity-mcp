import { z } from "zod";
import { access } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit, isCLIAvailable, stripAnsi } from "../utils/cli-bridge.js";
import { lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";

/** Strip ANSI escape codes from CLI output before string matching. */
// eslint-disable-next-line no-control-regex
function extractPublicVarityUrl(output: string): string | null {
  const match = output.match(/https?:\/\/(?:[a-z0-9-]+\.)?varity\.app(?:\/[^\s"'<>)]*)?/i);
  return match?.[0] ?? null;
}

export function deployAccepted(stdout: string, stderr = "") {
  const output = stripAnsi(`${stdout}\n${stderr}`);
  const acceptance = lifecycleAcceptance(stdout, "deploying");
  const reportedUrl = extractPublicVarityUrl(output);
  return successResponse(
    {
      accepted: true,
      ...acceptance,
      reported_url: reportedUrl,
    },
    acceptance.status_command
      ? `Deploy accepted. Track its terminal outcome with: ${acceptance.status_command}`
      : "The deploy command returned success without a durable tracking reference. A live deployment is not yet proven; inspect varity_deploy_status before reporting completion."
  );
}

export function registerDeployTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy",
    {
      title: "Deploy to Production",
      description:
        "Submit the current project to Varity's deployment owner through varitykit. " +
        "The CLI and control plane detect the framework, select hosting, build, and manage lifecycle state. " +
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
    async ({ path, repo_url, app_name, image, port, volume_size, volume_path }) => {
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
        return deployAccepted(result.stdout, result.stderr);
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
            ? "The local deploy process exhausted available memory. Free memory or use a larger development environment, then retry; the required memory depends on the project and build toolchain."
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
          "The varitykit CLI is installed but not working; its runtime or dependencies could not load.",
          "Run varity_doctor for detailed diagnosis, then reinstall in an isolated environment with: pipx install --force varitykit"
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
