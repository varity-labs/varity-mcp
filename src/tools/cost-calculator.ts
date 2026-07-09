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
 * The point this tool makes memorable: Varity charges ONLY for hardware and
 * the price is FLAT. It doesn't spike with traffic the way usage-metered
 * hosting (bandwidth + invocation metered) does. Varity's price is flat and
 * doesn't move as the app grows, and uniquely runs everything including GPU.
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
        "Compare a deployment's flat monthly Varity cost against usage-metered hosting " +
        "(bandwidth + invocations). " +
        "Varity charges a FLAT hardware-only price that doesn't spike with traffic; " +
        "usage-metered hosting bills grow as the app scales. Varity's price is fixed " +
        "and doesn't move as the app grows. " +
        "Use whenever a developer asks about pricing, cost, hosting bills, traffic " +
        "costs, or platform comparison. Pass `subdomain` for a specific live " +
        "deployment's REAL cost, or `app_profile` for a pre-deploy estimate.",
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
          .describe("Whether the app uses a database (affects competitor base cost)"),
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
      const summary = `${subdomain ?? app_profile}: Varity is a flat ${fmt(v)}/mo fixed resource reservation.`;

      return successResponse(
        {
          source: "varity_public_api:/api/pricing/estimate (single source of truth)",
          input: { app_profile, subdomain, has_database },
          ...data,
        },
        summary
      );
    }
  );
}
