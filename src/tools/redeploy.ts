import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { redeploy, VarityPublicApiError } from "../utils/public-api.js";
import { lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";
import { INFRASTRUCTURE } from "../utils/config.js";

/** `varity_redeploy` → `POST /api/deployments/:name/redeploy` through the one public-API client. */
export async function redeployAccepted(
  name: string,
  accepted: Awaited<ReturnType<typeof redeploy>>
) {
  const acceptance = await lifecycleAcceptance(accepted);
  return successResponse(
    { name, action: "redeploy", ...acceptance },
    acceptance.run_id
      ? `Reapply accepted for "${name}" on the same app URL (run ${acceptance.run_id}, status ${acceptance.public_status ?? "unobserved"}). Track its terminal outcome with varity_deploy_status.`
      : `The reapply request for "${name}" returned no run. The terminal outcome is not proven; inspect varity_deploy_status before retrying.`
  );
}

export function registerRedeployTool(server: McpServer): void {
  server.registerTool(
    "varity_redeploy",
    {
      annotations: { destructiveHint: true },
      title: "Reapply an Existing Deployment Configuration",
      description:
        "Reapply the saved configuration for an app that is ALREADY deployed. Use this when a developer " +
        "explicitly asks to reapply or redeploy that saved configuration. The app keeps the same deployment and URL. " +
        "An unchanged configuration may be a no-op, so this tool must not " +
        "be presented as a verified restart for a stuck app. Configure secrets through an approved secret-safe interface. " +
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
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? "Retry the redeploy request later.");
        }
        return errorResponse("REDEPLOY_FAILED", `Could not redeploy "${name}".`, "Retry the redeploy request later.");
      }
    }
  );
}
