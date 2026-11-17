import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { DEPLOYMENT_CARD_URI } from "../apps/deployment-card.js";
import { errorResponse, successResponse } from "../utils/responses.js";
import { getDeployment, VarityPublicApiError } from "../utils/public-api.js";
import { latestRunFailure, normalizeDeployment, readRun } from "./deploy-status.js";

/**
 * `varity_show_deployment`: the hosted render tool (design d1-hosted §2f). One
 * owner-scoped read; the card fields are the served values (price and billing
 * model from the deployment's billing block), never computed. It is the only
 * tool that carries the card's `_meta.ui.resourceUri`, and the card's Refresh
 * calls it again, so one module owns the card shape and its failure reason.
 */
export function registerShowDeploymentTool(server: McpServer): void {
  registerAppTool(
    server,
    "varity_show_deployment",
    {
      title: "Show Deployment Card",
      description:
        "Show a deployment as a card with its monthly price, status steps and live URL. " +
        "Call it after varity_deploy or varity_deploy_template with the returned id, or for any deployment the user asks to see.",
      inputSchema: {
        deployment_id: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment ID format")
          .describe("The deployment id varity_deploy returned, or the app's name."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: DEPLOYMENT_CARD_URI } },
    },
    async ({ deployment_id }) => {
      try {
        const deployment = normalizeDeployment(await getDeployment(deployment_id));
        // The same failure reason varity_deploy_status gives: the row outcome, else the run view's.
        const run = await readRun(deployment.run_id);
        deployment.run_status = run.status;
        const billing = deployment.billing ?? {};
        const served = (value: unknown) =>
          typeof value === "string" && value ? value : typeof value === "number" ? String(value) : null;
        const card = {
          id: deployment.id,
          app_name: deployment.appName,
          status: deployment.status,
          url: deployment.status === "deleted" ? null : deployment.url ?? null,
          monthly_price_usd: served(billing.fixed_monthly_cost_usd),
          billing_model: served(billing.billing_model),
          failure: latestRunFailure(deployment, run.outcome),
        };
        const where = card.url ? ` at ${card.url}` : "";
        return {
          ...successResponse(card, `Deployment ${card.id}: ${card.status}${where}${card.failure ? `; ${card.failure}` : ""}`),
          structuredContent: card,
        };
      } catch (err) {
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? "Check the deployment id with varity_deploy_status.");
        }
        return errorResponse("VARITY_API_ERROR", "Varity API request failed.", "Retry varity_show_deployment.");
      }
    }
  );
}
