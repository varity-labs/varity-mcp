import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { redeploy, VarityPublicApiError } from "../utils/public-api.js";
import { lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";
import { INFRASTRUCTURE } from "../utils/endpoints.js";

/** `varity_redeploy` → `POST /api/deployments/:name/redeploy` through the one public-API client. */
export async function redeployAccepted(
  name: string,
  accepted: Awaited<ReturnType<typeof redeploy>>
) {
  const acceptance = await lifecycleAcceptance(accepted);
  return successResponse(
    { name, action: "redeploy", ...acceptance },
    acceptance.run_id
      ? `Restart of the last release accepted for "${name}" on the same app URL (run ${acceptance.run_id}, status ${acceptance.public_status ?? "unobserved"}). Track its terminal outcome with varity_deploy_status.`
      : `The restart request for "${name}" returned no run. The terminal outcome is not proven; inspect varity_deploy_status before retrying.`
  );
}

export function registerRedeployTool(server: McpServer): void {
  server.registerTool(
    "varity_redeploy",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Restart an App's Last Release",
      description:
        "Restart an app that is ALREADY deployed from its last successful release, at that release's saved commit " +
        "and configuration. The app keeps the same deployment and URL. It does not pick up new commits: to ship new " +
        "code, push it and call varity_deploy again with the same app_name. An app with no successful release cannot " +
        "be restarted. Redeploy restarts dynamic and container apps only; for a static site, push the change and " +
        "call varity_deploy again with the same app_name. Configure secrets through an approved secret-safe interface. " +
        "To create a NEW deployment instead, use varity_deploy.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid app name")
          .describe(
            "The subdomain / app name of the existing deployment to redeploy, the slug in https://varity.app/<name>/. Example: 'my-api'."
          ),
      },
    },
    async ({ name }) => {
      try {
        return await redeployAccepted(name, await redeploy(name));
      } catch (err) {
        if (err instanceof VarityPublicApiError && err.status === 404) {
          return errorResponse(
            "DEPLOYMENT_NOT_FOUND",
            `No deployment found with name "${name}".`,
            `Check the exact name with varity_deploy_status or at ${INFRASTRUCTURE.DASHBOARD}.`
          );
        }
        if (err instanceof VarityPublicApiError && (err.status === 409 || err.status === 501)) {
          // A static site's release cannot be restarted: 409/501, retryable:false (E1 journey 3). A 409 can
          // also mean another operation on the app is still running, so both remedies are named.
          return errorResponse(
            err.code,
            `Redeploy of "${name}" was refused: ${err.message} Redeploy restarts dynamic and container apps only.`,
            "For a static site, push the change and call varity_deploy again with the same app_name; it ships the new " +
              "code at the same URL. If another operation on this app is still running, wait until varity_deploy_status shows it finished."
          );
        }
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? "Retry the redeploy request later.");
        }
        return errorResponse("REDEPLOY_FAILED", `Could not redeploy "${name}".`, "Retry the redeploy request later.");
      }
    }
  );
}
