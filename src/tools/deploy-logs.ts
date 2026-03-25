import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeploymentsDir } from "../utils/config.js";

export function registerDeployLogsTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy_logs",
    {
      title: "Deployment Logs",
      description:
        "Get build and deployment logs for a specific deployment. " +
        "Useful for debugging failed deployments or checking build output. " +
        "Use this when a developer asks why a deployment failed, wants to see build logs, " +
        "or needs to debug an issue.",
      inputSchema: {
        deployment_id: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment ID format")
          .describe("The deployment ID to get logs for"),
        limit: z
          .coerce.number()
          .optional()
          .default(100)
          .describe("Maximum number of log lines to return (default: 100)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ deployment_id, limit }) => {
      const deploymentsDir = getDeploymentsDir();

      // Try to read the log file for this deployment
      const logPaths = [
        join(deploymentsDir, `${deployment_id}.log`),
        join(deploymentsDir, deployment_id, "build.log"),
        join(deploymentsDir, deployment_id, "deploy.log"),
      ];

      for (const logPath of logPaths) {
        try {
          const content = await readFile(logPath, "utf-8");
          const lines = content.split("\n");
          const truncated = lines.slice(-limit);

          return successResponse(
            {
              deployment_id,
              log_lines: truncated,
              total_lines: lines.length,
              truncated: lines.length > limit,
              log_path: logPath,
            },
            `Showing ${truncated.length} of ${lines.length} log lines for deployment ${deployment_id}`
          );
        } catch {
          // Try next path
        }
      }

      // Try to read the deployment JSON for any embedded logs
      try {
        const jsonPath = join(deploymentsDir, `${deployment_id}.json`);
        const content = await readFile(jsonPath, "utf-8");
        const data = JSON.parse(content);

        if (data.logs || data.build_output || data.output) {
          const logs = data.logs || data.build_output || data.output;
          const logText = typeof logs === "string" ? logs : JSON.stringify(logs, null, 2);
          const lines = logText.split("\n").slice(-limit);

          return successResponse(
            {
              deployment_id,
              log_lines: lines,
              total_lines: lines.length,
              source: "deployment_record",
            },
            `Found embedded logs for deployment ${deployment_id}`
          );
        }

        // No raw logs, but extract build metadata as a structured summary
        const buildInfo = data.build || {};
        const ipfsInfo = data.ipfs || {};
        const summaryLines = [
          `Deployment: ${deployment_id}`,
          `Timestamp:  ${data.timestamp || data.deployed_at || "unknown"}`,
          `Framework:  ${data.project?.type || data.framework || "unknown"}`,
          `Hosting:    ${data.hosting || "unknown"}`,
          `Status:     ${buildInfo.success ? "success" : "unknown"}`,
          ...(buildInfo.time_seconds ? [`Build time: ${buildInfo.time_seconds.toFixed(1)}s`] : []),
          ...(buildInfo.size_mb ? [`Build size: ${buildInfo.size_mb.toFixed(1)} MB`] : []),
          ...(buildInfo.files ? [`Files:      ${buildInfo.files}`] : []),
          ...(buildInfo.output_dir ? [`Output dir: ${buildInfo.output_dir}`] : []),
          ...(ipfsInfo.cid ? [`IPFS CID:   ${ipfsInfo.cid}`] : []),
          ...(ipfsInfo.gateway_url ? [`Live URL:   ${ipfsInfo.gateway_url}`] : []),
          ...(data.custom_domain?.url ? [`Domain:     ${data.custom_domain.url}`] : []),
        ];

        return successResponse(
          {
            deployment_id,
            log_lines: summaryLines,
            total_lines: summaryLines.length,
            source: "deployment_record",
            deployment_info: {
              url: data.custom_domain?.url || ipfsInfo.gateway_url || data.url || data.deployment_url,
              status: buildInfo.success ? "deployed" : "unknown",
              timestamp: data.timestamp || data.deployed_at,
              build_time: buildInfo.time_seconds ? `${buildInfo.time_seconds.toFixed(1)}s` : undefined,
              build_size: buildInfo.size_mb ? `${buildInfo.size_mb.toFixed(1)} MB` : undefined,
            },
          },
          `Build summary for deployment ${deployment_id} (no raw build logs available)`
        );
      } catch {
        // No deployment record either
      }

      // Check if any deployments exist at all
      try {
        const files = await readdir(deploymentsDir);
        const ids = files
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.replace(".json", ""));

        if (ids.length > 0) {
          const recentIds = ids.slice(-5);
          return errorResponse(
            "LOGS_NOT_FOUND",
            `No logs found for deployment "${deployment_id}".`,
            `Recent deployments: ${recentIds.join(", ")}. Use varity_deploy_status to list all.`
          );
        }
      } catch {
        // Deployments dir doesn't exist
      }

      return errorResponse(
        "NO_DEPLOYMENTS",
        "No deployments found on this machine.",
        "Deploy an app first with the varity_deploy tool."
      );
    }
  );
}
