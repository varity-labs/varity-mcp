import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeploymentLogs, VarityPublicApiError } from "../utils/public-api.js";
import { stripAnsi } from "../utils/ansi.js";

export function registerDeployLogsTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy_logs",
    {
      title: "Deployment Info & Logs",
      description:
        "Get recent runtime logs for a deployment from the Varity public API. " +
        "Use this when a developer asks for logs from a live app. " +
        "If a deploy failed while building, call varity_deploy_status with the deployment: it returns the build error lines.",
      inputSchema: {
        deployment: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment id or app name")
          .optional()
          .describe("The deployment id or app name to get logs for"),
        deployment_id: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment id or app name")
          .optional()
          .describe("Same as deployment (the name varity_deploy_status uses); pass either one."),
        limit: z
          .coerce.number()
          .optional()
          .default(100)
          .describe("Maximum number of log lines to return (default: 100)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ deployment: name, deployment_id, limit }) => {
      if (name && deployment_id && name !== deployment_id) {
        return errorResponse("DEPLOYMENT_CONFLICT", "deployment and deployment_id name different apps.", "Pass one of them.");
      }
      const deployment = name ?? deployment_id;
      if (!deployment) {
        return errorResponse("DEPLOYMENT_REQUIRED", "Name the app to read logs for.", "Pass deployment (the id or app name).");
      }
      try {
        const data = await getDeploymentLogs(deployment, limit ?? 100);
        const logLines = (data.lines ?? []).map((line) => {
          const text = typeof line.message === "string" ? line.message : JSON.stringify(line);
          return stripAnsi(text);
        });

        // Only an explicit `complete: true` from the public API is complete.
        // `false` (the window may be missing recent lines) and absent (an
        // older gateway did not report it) are both not-complete: unobserved
        // is never success (evidence p2-cli-mcp D8).
        const complete = data.complete === true;
        const partial = !complete;
        const summary = partial
          ? `Showing ${logLines.length} log line(s) for deployment ${deployment}. `
            + "These logs may be delayed or partial — retry shortly for a complete window."
          : `Showing ${logLines.length} log line(s) for deployment ${deployment}`;

        return successResponse(
          {
            deployment,
            log_lines: logLines,
            total_lines: data.count ?? logLines.length,
            complete,
            observed_at: data.observed_at ?? null,
            source: "varity_public_api:/api/deployments/{id}/logs",
          },
          summary
        );
      } catch (err) {
        // A static site has no runtime, so no runtime logs: a normal answer, not an error.
        if (err instanceof VarityPublicApiError && err.code === "runtime_not_started" && /^This is a static site\b/.test(err.message)) {
          return successResponse(
            { deployment, log_lines: [], total_lines: 0, complete: true, static_site: true },
            `${deployment} is a static site: it is served as files and has no server, so it has no runtime logs. That is normal.`
          );
        }
        if (err instanceof VarityPublicApiError) {
          return errorResponse(
            err.code,
            err.message,
            err.action ?? (err.code === "runtime_not_started"
              ? "Call varity_deploy_status with this deployment for its build and publish outcome."
              : "Use varity_deploy_status to confirm the deployment id or app slug.")
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
