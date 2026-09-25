import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { deleteDeployment, VarityPublicApiError } from "../utils/public-api.js";
import { lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";
import { INFRASTRUCTURE } from "../utils/config.js";

/**
 * `varity_delete_deployment` → `DELETE /api/deployments/:deployment` through
 * the one public-API client. The gateway resolves an id or an app name,
 * including a failed deploy that never got a route (varity-gateway
 * services/deploy-ops-public.ts `resolveOwnedDeployment`).
 */
export async function deleteAccepted(
  deployment: string,
  accepted: Awaited<ReturnType<typeof deleteDeployment>>
) {
  const acceptance = await lifecycleAcceptance(accepted);
  const deleted = accepted.deleted === true || acceptance.public_status === "deleted";
  return successResponse(
    { deployment, ...acceptance, deleted },
    deleted
      ? `"${deployment}" is deleted.`
      : acceptance.run_id
        ? `Delete accepted for "${deployment}" (run ${acceptance.run_id}, status ${acceptance.public_status ?? "unobserved"}). Route removal, reserved hardware release, and billing stop are complete only when varity_deploy_status shows it deleted.`
        : `The delete request for "${deployment}" returned no run. Deletion and billing stop are not proven; check varity_deploy_status before retrying.`
  );
}

export function registerDeleteDeploymentTool(server: McpServer): void {
  server.registerTool(
    "varity_delete_deployment",
    {
      annotations: { destructiveHint: true },
      title: "Delete a Deployment and Stop Its Billing",
      description:
        "Request deletion of an existing Varity deployment by id or app name and track it until billing stop is proven. " +
        "Use this when a developer says 'stop my <name>', 'shut down my deployment', 'I'm done with <name>', " +
        "'delete <name>', or when they no longer need a running app or agent. " +
        "The durable operation independently reconciles route removal, reserved hardware release, and billing stop. " +
        `Use varity_deploy_status or list deployments at ${INFRASTRUCTURE.DASHBOARD} to confirm the deployment first if the developer is unsure.`,
      inputSchema: {
        deployment: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment id or app name")
          .describe(
            "The deployment id or app name (the slug in https://varity.app/<name>/), " +
              "including a deployment that failed before it got a URL. Example: 'worker-bot'."
          ),
      },
    },
    async ({ deployment }) => {
      try {
        return await deleteAccepted(deployment, await deleteDeployment(deployment));
      } catch (err) {
        if (err instanceof VarityPublicApiError && err.status === 404) {
          return errorResponse(
            "DEPLOYMENT_NOT_FOUND",
            `No deployment found for "${deployment}".`,
            `Check the id or name with varity_deploy_status or at ${INFRASTRUCTURE.DASHBOARD}.`
          );
        }
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? `Check ${INFRASTRUCTURE.DASHBOARD}.`);
        }
        return errorResponse("DELETE_FAILED", `Could not delete "${deployment}".`, "Retry the request.");
      }
    }
  );
}
