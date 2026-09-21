import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeployment, publicApiGet, VarityPublicApiError } from "../utils/public-api.js";

/**
 * varity_cost_calculator, THIN CLIENT.
 *
 * Pricing policy and values live behind the public Varity interface. This tool
 * forwards estimate inputs or projects the billing fields returned for an
 * owner-scoped deployment; it owns no profile catalog or billing defaults.
 *
 * The tool reports only the monthly estimate field returned by the owner.
 * No comparisons, markups, billing defaults, or savings math happen here.
 */

export function registerCostCalculatorTool(server: McpServer): void {
  server.registerTool(
    "varity_cost_calculator",
    {
      title: "Cost Calculator",
      description:
        "Request a current deployment-price estimate from the Varity public pricing interface. " +
        "Use whenever a developer asks what a Varity deployment costs. " +
        "Pass `subdomain` for a live deployment's current billing projection, or " +
        "`app_profile` for a pre-deploy estimate.",
      inputSchema: {
        app_profile: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "Invalid pricing profile key")
          .optional()
          .describe(
            "Optional profile key understood by the live Varity pricing API. Omit to use the API's current default."
          ),
        subdomain: z
          .string()
          .optional()
          .describe(
            "A live deployment's subdomain; returns its current billing projection and overrides app_profile"
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app_profile, subdomain }) => {
      let data: Record<string, unknown>;
      let source: string;
      try {
        if (subdomain) {
          const deployment = await getDeployment(subdomain);
          const billing = deployment.billing ?? {};
          data = {
            profile: billing.profile,
            currency: billing.currency,
            fixed_monthly_cost_usd:
              billing.fixed_monthly_cost_usd ??
              billing.fixed_monthly_usd ??
              billing.monthlyUsd,
            billing_model: billing.billing_model,
            deployment,
          };
          source = "varity_public_api:/api/deployments/:id#billing";
        } else {
          const qs = new URLSearchParams();
          if (app_profile) qs.set("profile", app_profile);
          const estimatePath = qs.size > 0
            ? `/api/pricing/estimate?${qs.toString()}`
            : "/api/pricing/estimate";
          data = await publicApiGet<Record<string, unknown>>(estimatePath);
          source = "varity_public_api:/api/pricing/estimate";
        }
      } catch (err) {
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? "Run varity_login, then retry pricing.");
        }
        return errorResponse(
          "pricing_unreachable",
          "Could not reach the Varity pricing service.",
          "Check your connection and retry, pricing is computed server-side so numbers stay consistent everywhere."
        );
      }

      const v = (data.fixed_monthly_cost_usd ?? data.varityMonthly) as number;
      if (typeof v !== "number") {
        return errorResponse(
          "pricing_unavailable",
          "Varity pricing is not available for that request.",
          "For a live deployment, confirm the app slug with varity_deploy_status."
        );
      }
      const fmt = (n: number) => `$${Number(n).toLocaleString("en-US")}`;
      const estimateName = subdomain ?? data.profile ?? app_profile ?? "current default profile";
      const summary = `${String(estimateName)}: ${fmt(v)}/mo estimate returned by the current Varity pricing interface.`;

      return successResponse(
        {
          source,
          input: { app_profile, subdomain },
          // Explicit whitelist of the pricing response fields this tool renders.
          // Never spread the raw response into the tool result.
          profile: data.profile,
          currency: data.currency,
          fixed_monthly_cost_usd: v,
          billing_model: data.billing_model,
          mode: data.mode,
          verified: data.verified,
          deployment: data.deployment,
        },
        summary
      );
    }
  );
}
