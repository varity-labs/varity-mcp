import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeploymentLogs, VarityPublicApiError } from "../utils/public-api.js";
import { stripAnsi } from "../utils/cli-bridge.js";

export function registerDeployLogsTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy_logs",
    {
      title: "Deployment Info & Logs",
      description:
        "Get recent runtime logs for a deployment from the Varity public API. " +
        "Use this when a developer asks for logs from a live app. " +
        "For local build errors before deployment, use varity_build.",
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
      try {
        const data = await getDeploymentLogs(deployment_id, limit ?? 100);
        const logLines = (data.lines ?? []).map((line) => {
          const text = typeof line.message === "string" ? line.message : JSON.stringify(line);
          return stripAnsi(text);
        });

        // Honestly surface partial/stale reads. The public API sets
        // `complete: false` when the returned window may be missing recent
        // lines (e.g. the live runtime source was momentarily unavailable), so
        // the agent does not treat a partial window as the whole log.
        const partial = data.complete === false;
        const summary = partial
          ? `Showing ${logLines.length} log line(s) for deployment ${deployment_id}. `
            + "These logs may be delayed or partial — retry shortly for a complete window."
          : `Showing ${logLines.length} log line(s) for deployment ${deployment_id}`;

        return successResponse(
          {
            deployment_id,
            log_lines: logLines,
            total_lines: data.count ?? logLines.length,
            complete: data.complete ?? true,
            observed_at: data.observed_at ?? null,
            source: "varity_public_api:/api/deployments/{id}/logs",
          },
          summary
        );
      } catch (err) {
        if (err instanceof VarityPublicApiError) {
          return errorResponse(
            err.code,
            err.message,
            err.action ?? "Use varity_deploy_status to confirm the deployment id or app slug."
          );
        }
        return errorResponse(
          "LOGS_UNAVAILABLE",
          "Could not load deployment logs.",
          "Use varity_deploy_status to confirm the deployment exists, then retry."
        );
      }
    }
  );
}
