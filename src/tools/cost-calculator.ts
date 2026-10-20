import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeployment, getPublicProfilePricing, VarityPublicApiError } from "../utils/public-api.js";

/**
 * varity_cost_calculator, THIN CLIENT.
 *
 * Pricing policy and values live behind the public Varity interface. This tool
 * forwards estimate inputs or projects the billing fields returned for an
 * owner-scoped deployment; it owns no profile catalog or billing defaults.
 *
 * A pre-deploy estimate reads the public `GET /api/pricing?profile=` (no
 * auth), the same computation the portal deploy page renders; a live
 * deployment's projection reads its owner-scoped billing block. The tool
 * reports the USD field the owner served under that field's own name and
 * never converts between units or invents a monthly projection. Money is USD
 * only.
 */

export type OwnerPricingProjection =
  | { unit: "month"; fixed_monthly_cost_usd: number }
  | { unit: "month"; monthly_max_usd: number }
  | { unit: "hour"; hourly_cost_usd: number };

export function projectOwnerPricing(data: Record<string, unknown>): OwnerPricingProjection | null {
  const monthly = data.fixed_monthly_cost_usd;
  if (typeof monthly === "number" && Number.isFinite(monthly)) {
    return { unit: "month", fixed_monthly_cost_usd: monthly };
  }
  // Public `GET /api/pricing` serves the reserved monthly maximum under this name.
  const monthlyMax = data.monthly_max_usd;
  if (typeof monthlyMax === "number" && Number.isFinite(monthlyMax)) {
    return { unit: "month", monthly_max_usd: monthlyMax };
  }
  const hourly = data.hourly_cost_usd;
  if (typeof hourly === "number" && Number.isFinite(hourly)) {
    return { unit: "hour", hourly_cost_usd: hourly };
  }
  return null;
}

export function registerCostCalculatorTool(server: McpServer): void {
  server.registerTool(
    "varity_cost_calculator",
    {
      title: "Cost Calculator",
      description:
        "Request a current deployment-price estimate from the Varity public pricing interface. " +
        "Use whenever a developer asks what a Varity deployment costs. " +
        "Pass `subdomain` for a live deployment's current billing projection (needs a deploy key), or " +
        "`app_profile` for a pre-deploy estimate (no sign-in needed). " +
        // Mirrors gateway PROFILE_PRICING keys for discoverability; the served
        // list in a `profile_unknown` refusal stays the authority.
        "Profiles: static-site (alias static), web-app, web-app-db, ai-agent-cpu, ai-agent-gpu; " +
        "an unknown profile returns the current list. All amounts are USD.",
      inputSchema: {
        app_profile: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "Invalid pricing profile key")
          .optional()
          .describe(
            "Pricing profile: static-site (or static), web-app, web-app-db, ai-agent-cpu, ai-agent-gpu. Omit for the default (web-app)."
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
          // Canonical served keys only: the served `billing` block has no
          // `profile` (D12) and its money aliases are being deleted (GW1b).
          data = {
            currency: billing.currency,
            fixed_monthly_cost_usd: billing.fixed_monthly_cost_usd,
            hourly_cost_usd: billing.hourly_cost_usd,
            billing_model: billing.billing_model,
            deployment,
          };
          source = "varity_public_api:/api/deployments/:id#billing";
        } else {
          try {
            data = await getPublicProfilePricing(app_profile);
          } catch (err) {
            if (err instanceof VarityPublicApiError && err.code === "profile_unknown") {
              const served = err.served?.profiles;
              const profiles = Array.isArray(served) ? served.join(", ") : "a profile from the tool description";
              return errorResponse(
                "profile_unknown",
                `Unknown pricing profile "${app_profile}".`,
                `Retry varity_cost_calculator with app_profile set to one of: ${profiles}.`
              );
            }
            throw err;
          }
          source = "varity_public_api:/api/pricing";
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

      const projection = projectOwnerPricing(data);
      if (!projection) {
        return errorResponse(
          "pricing_unavailable",
          "Varity pricing is not available for that request.",
          "For a live deployment, confirm the app slug with varity_deploy_status."
        );
      }
      const fmt = (n: number) => `$${Number(n).toLocaleString("en-US")}`;
      const estimateName = subdomain ?? data.profile ?? app_profile ?? "current default profile";
      const { unit, ...served } = projection;
      const amount = Object.values(served)[0] as number;
      const upTo = "monthly_max_usd" in projection && amount > 0 ? "up to " : "";
      const summary = `${String(estimateName)}: ${upTo}${fmt(amount)}/${unit === "month" ? "mo" : "hour"} (USD) estimate returned by the current Varity pricing interface.`;

      return successResponse(
        {
          source,
          input: { app_profile, subdomain },
          // Explicit whitelist of the pricing response fields this tool renders.
          // Never spread the raw response into the tool result.
          profile: data.profile,
          currency: data.currency,
          ...served,
          billing_model: data.billing_model,
          billing_note: data.billing_note,
          mode: data.mode,
          verified: data.verified,
          deployment: data.deployment,
        },
        summary
      );
    }
  );
}
