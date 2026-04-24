import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeploymentsDir } from "../utils/config.js";

/** Strip ANSI escape codes so log lines render cleanly in MCP clients. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function registerDeployLogsTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy_logs",
    {
      title: "Deployment Info & Logs",
      description:
        "Get build logs or deployment summary for a specific deployment. " +
        "When full build logs exist (captured during varity_deploy or varity_build), returns the actual log lines. " +
        "When only the deployment record exists, returns a structured summary receipt: " +
        "URL, status, build size, build time, and a debug_tip pointing to varity_build for detailed output. " +
        "Use this to get the live URL, check status, or confirm build metrics for a deployment. " +
        "For detailed build error output (TypeScript errors, module-not-found, etc.), use varity_build — " +
        "it captures the full compilation log with exact file/line numbers.",
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
          const raw = await readFile(logPath, "utf-8");
          const content = stripAnsi(raw);
          const lines = content.split("\n");
          const truncated = lines.slice(-limit);

          const annotatedLines = truncated.map((line) => {
            // Rewrite CLI command references to MCP equivalents so log output
            // makes sense when read through varity_deploy_logs.
            if (line.includes("varitykit app deploy --submit-to-store")) {
              return line.replace(
                /varitykit app deploy --submit-to-store/g,
                "varity_submit_to_store (MCP tool)"
              );
            }
            // Annotate the "shared development database" build-phase message so
            // developers reading post-deploy logs are not misled into thinking
            // their production app lacks a private database (DX-005).
            if (line.includes("Using shared development database")) {
              return line + " ← build-phase only; your deployed app has a private database";
            }
            return line;
          });

          return successResponse(
            {
              deployment_id,
              log_lines: annotatedLines,
              total_lines: lines.length,
              truncated: lines.length > limit,
              log_path: logPath,
            },
            `Showing ${annotatedLines.length} of ${lines.length} log lines for deployment ${deployment_id}`
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
          const logRaw = typeof logs === "string" ? logs : JSON.stringify(logs, null, 2);
          const lines = stripAnsi(logRaw).split("\n").slice(-limit);

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
        // Build clean summary from deployment metadata
        const appName = data.app_name || data.project_name || deployment_id;
        const liveUrl = data.custom_domain?.url || `https://varity.app/${appName}/`;
        const summaryLines = [
          `Deployment: ${deployment_id}`,
          `App:        ${appName}`,
          `Live URL:   ${liveUrl}`,
          `Timestamp:  ${data.timestamp || data.deployed_at || "unknown"}`,
          `Framework:  ${data.project?.type || data.framework || "unknown"}`,
          `Hosting:    ${data.hosting === "ipfs" ? "static" : data.hosting || "unknown"}`,
          `Status:     ${buildInfo.success ? "deployed" : "unknown"}`,
          ...(buildInfo.time_seconds ? [`Build time: ${buildInfo.time_seconds.toFixed(1)}s`] : []),
          ...(buildInfo.size_mb ? [`Build size: ${buildInfo.size_mb.toFixed(1)} MB`] : []),
          ...(buildInfo.files ? [`Files:      ${buildInfo.files}`] : []),
        ];

        return successResponse(
          {
            deployment_id,
            log_lines: summaryLines,
            total_lines: summaryLines.length,
            source: "deployment_record",
            deployment_info: {
              // Always use clean varity.app URL — never expose raw IPFS or provider URLs
              url: liveUrl,
              status: buildInfo.success ? "deployed" : "unknown",
              timestamp: data.timestamp || data.deployed_at,
              build_time: buildInfo.time_seconds ? `${buildInfo.time_seconds.toFixed(1)}s` : undefined,
              build_size: buildInfo.size_mb ? `${buildInfo.size_mb.toFixed(1)} MB` : undefined,
            },
            debug_tip: "Full build logs are not stored for this deployment. To see detailed build output, use the varity_build tool — it captures compilation errors with exact file and line numbers.",
          },
          `Build summary for deployment ${deployment_id}. Use varity_build to capture detailed compilation output.`
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
          return errorResponse(
            "LOGS_NOT_FOUND",
            `No logs found for deployment "${deployment_id}".`,
            `Use varity_deploy_status to list your deployments and find the correct deployment ID.`
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
