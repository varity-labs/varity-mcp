import { z } from "zod";
import { readdir, readFile, access } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit, isCLIAvailable } from "../utils/cli-bridge.js";
import { getDeploymentsDir } from "../utils/config.js";

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
            "Path to the project directory (default: current workspace root)"
          ),
        submit_to_store: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Also submit the app to the Varity App Store for monetization (90% revenue to developer)"
          ),
      },
      annotations: {
        destructiveHint: true, // Deploys real infrastructure
      },
    },
    async ({ path, submit_to_store }) => {
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

      const args = ["deploy"];

      if (submit_to_store) {
        args.push("--submit-to-store");
      }

      const result = await execVaritykit("app", args, {
        cwd,
        timeout: 300_000, // 5 minutes for build + deploy
      });

      if (result.exitCode === 0) {
        // Parse deploy output for URL and metadata
        const output = result.stdout + "\n" + result.stderr;

        // Try to read the latest deployment record (most reliable source of URL)
        let deployUrl = "unknown";
        let buildSize = "unknown";
        let fileCount = "unknown";
        let deploymentId = "unknown";

        try {
          const deploymentsDir = getDeploymentsDir();
          const files = await readdir(deploymentsDir);
          const jsonFiles = files.filter((f) => f.endsWith(".json")).sort().reverse();
          if (jsonFiles.length > 0) {
            const latest = JSON.parse(
              await readFile(`${deploymentsDir}/${jsonFiles[0]}`, "utf-8")
            );
            deployUrl =
              latest.custom_domain?.url ||
              latest.ipfs?.gateway_url ||
              latest.ipfs?.thirdweb_url ||
              latest.akash?.url ||
              latest.url ||
              "unknown";
            buildSize = latest.build?.size_mb
              ? `${latest.build.size_mb.toFixed(1)} MB`
              : "unknown";
            fileCount = String(latest.build?.files ?? latest.ipfs?.file_count ?? "unknown");
            deploymentId = latest.deployment_id || jsonFiles[0]!.replace(".json", "");
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
            submitted_to_store: submit_to_store,
            share_card: cardUrl || undefined,
            share_image: cardUrl ? `${cardUrl}/image.png` : undefined,
            infrastructure: {
              hosting: "Varity (global)",
              database: "Database (included)",
              auth: "Authentication (included)",
            },
            next_steps: submit_to_store
              ? [
                  `App live at: ${deployUrl}`,
                  "App submitted to Varity App Store",
                  "Revenue split: 90% to you, 10% platform fee",
                  ...(cardUrl ? [`Share your deployment: ${cardUrl}`] : []),
                ]
              : [
                  `App live at: ${deployUrl}`,
                  ...(cardUrl ? [`Share your deployment: ${cardUrl}`] : []),
                  "To monetize: run deploy again with submit_to_store=true",
                  `Or visit: https://developer.store.varity.so`,
                ],
          },
          `Deployed successfully! Live at: ${deployUrl}${cardUrl ? ` | Share: ${cardUrl}` : ""}`
        );
      }

      // Deploy failed — parse error for helpful suggestion
      const output = result.stderr || result.stdout;

      if (
        output.includes("No framework detected") ||
        output.includes("not found") ||
        output.includes("Aborted")
      ) {
        return errorResponse(
          "NO_FRAMEWORK",
          `Could not detect a supported framework in: ${cwd}`,
          "Ensure you have a package.json with Next.js, React, or Vue. Run from the project root directory."
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
        "Check the error above. Common fixes: ensure dependencies are installed (npm install), check for build errors (npm run build)."
      );
    }
  );
}
