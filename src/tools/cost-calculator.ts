import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeployment, publicApiGet, VarityPublicApiError } from "../utils/public-api.js";

/**
 * varity_cost_calculator, THIN CLIENT.
 *
 * All pricing logic + the single source of truth lives in the gateway
 * (`GET /api/pricing/estimate`). This tool calls it so the MCP terminal output and the
 * developer-portal deploy page render the IDENTICAL computation, no
 * duplicated pricing numbers anywhere.
 *
 * The tool reports the fixed monthly price for the reserved deployment
 * profile as computed server-side. No comparisons, markups, or savings math
 * happen in this client.
 */

const PROFILE_KEYS = [
  "static-site",
  "web-app",
  "web-app-db",
  "ai-agent-cpu",
  "ai-agent-gpu",
] as const;

export function registerCostCalculatorTool(server: McpServer): void {
  server.registerTool(
    "varity_cost_calculator",
    {
      title: "Cost Calculator",
      description:
        "Estimate the fixed monthly price for a deployment profile. " +
        "Pricing is computed by the Varity pricing service, so this tool, the CLI, " +
        "and the portal render identical numbers. " +
        "Use whenever a developer asks what a Varity deployment costs. " +
        "Pass `subdomain` for a specific live deployment's REAL cost, or " +
        "`app_profile` for a pre-deploy estimate.",
      inputSchema: {
        app_profile: z
          .enum(PROFILE_KEYS)
          .optional()
          .default("web-app")
          .describe(
            "Pre-deploy estimate preset. Accepted values: static-site, web-app, web-app-db, ai-agent-cpu, ai-agent-gpu. Estimates are computed by the live Varity pricing API."
          ),
        subdomain: z
          .string()
          .optional()
          .describe(
            "A live deployment's subdomain → returns THIS deployment's real cost (overrides app_profile)"
          ),
        has_database: z
          .boolean()
          .optional()
          .describe("Whether the app uses a database (selects the database-inclusive estimate)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app_profile, subdomain, has_database }) => {
      let data: Record<string, unknown>;
      try {
        if (subdomain) {
          const deployment = await getDeployment(subdomain);
          const billing = deployment.billing ?? {};
          data = {
            profile: "live-deployment",
            currency: "USD",
            fixed_monthly_cost_usd:
              billing.fixed_monthly_cost_usd ??
              billing.fixed_monthly_usd ??
              billing.monthlyUsd,
            billing_model: "fixed_monthly_resource_reservation",
            deployment,
          };
        } else {
          const qs = new URLSearchParams();
          qs.set("profile", app_profile || "web-app");
          if (has_database !== undefined) qs.set("has_db", String(has_database));
          data = await publicApiGet<Record<string, unknown>>(`/api/pricing/estimate?${qs.toString()}`);
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
      const summary = `${subdomain ?? app_profile}: up to ${fmt(v)}/mo for this reserved deployment, prorated by running time.`;

      return successResponse(
        {
          source: "varity_public_api:/api/pricing/estimate (single source of truth)",
          input: { app_profile, subdomain, has_database },
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
