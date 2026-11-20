import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeployment, getPublicProfilePricing, VarityPublicApiError } from "../utils/public-api.js";
import { monthlyMaximum, usd } from "../utils/money.js";

/**
 * varity_cost_calculator, THIN CLIENT.
 *
 * Pricing policy and values live behind the public Varity interface. This tool
 * forwards estimate inputs or projects the billing fields returned for an
 * owner-scoped deployment; it owns no profile catalog or billing defaults.
 *
 * A pre-deploy estimate reads the public `GET /api/pricing?profile=`, sending
 * the deploy key when one is configured so the owner can price a static site
 * for the caller's account; a live deployment's projection reads its
 * owner-scoped billing block. A static estimate states a price only when the
 * owner served `quote_scope: "account"`: an anonymous quote, or one from an
 * owner that ignored the key, is the first-site assumption, not the caller's
 * price (FX-1). The tool
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

/** A served estimate for the Starter plan alone, with no attached service or added storage. */
function isPlainStarter(data: Record<string, unknown>): boolean {
  const preset = data.preset as { id?: unknown } | null | undefined;
  return preset?.id === "starter" && data.attached_services == null && data.persistent_storage == null;
}

/**
 * GPU containers are hidden on every customer surface (founder ruling
 * 2026-10-27); GPU virtual machines remain, priced by their own quote. The one
 * profile this tool refuses: never sent, and never offered from a served menu.
 */
const GPU_CONTAINER_PROFILE = "ai-agent-gpu";

/** The served `billing_model` of a monthly maximum charged by running time. */
const PRORATED_MONTHLY_MAX = "reserved_monthly_max_prorated";

/** The served note's words, trimmed and closed as a sentence only when it has
 *  no terminal punctuation (before any closing quote or bracket); the
 *  structured `billing_note` stays exactly as served. */
function summaryNote(data: Record<string, unknown>): string {
  const servedNote = typeof data.billing_note === "string" ? data.billing_note.trim() : "";
  const closed = /[.!?…]["'’”)\]]*$/.test(servedNote);
  return servedNote ? `${servedNote}${closed ? "" : "."}` : "";
}

/**
 * FX-1: whether a new static site is free depends on how many static sites
 * the account already runs, so its price is stated only when the owner served
 * `quote_scope: "account"`. Any other static estimate (anonymous, or from an
 * owner that ignored the key and sends no scope) is the first-site
 * assumption, not the caller's price.
 */
function isUnpricedStaticQuote(data: Record<string, unknown>): boolean {
  return data.mode === "static" && data.quote_scope !== "account";
}

function unpricedStaticResponse(
  data: Record<string, unknown>,
  source: string,
  input: { app_profile?: string; subdomain?: string },
) {
  const scope = typeof data.quote_scope === "string" ? data.quote_scope : null;
  const why = scope === null ? ", because Varity did not check your account" : "";
  const note = summaryNote(data);
  const signIn = scope === "anonymous" ? " Run varity_login, then ask again." : "";
  const name = String(data.profile ?? input.app_profile ?? "static-site");
  return successResponse(
    {
      source,
      input,
      // Explicit whitelist: no price field and no billing model, so nothing
      // in the result reads as this caller's price.
      profile: data.profile,
      currency: data.currency,
      quote_scope: scope,
      free_sites_included: data.free_sites_included,
      additional_site_monthly_usd: data.additional_site_monthly_usd,
      billing_note: data.billing_note,
      mode: data.mode,
      verified: data.verified,
    },
    `${name}: no price stated${why}.${note ? ` ${note}` : ""}${signIn}`
  );
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
        "`app_profile` for a pre-deploy estimate. When signed in, a static site is priced for your account, " +
        "because whether it is free depends on how many static sites you already run; otherwise no static price is stated. " +
        // Mirrors gateway PROFILE_PRICING keys for discoverability; the served
        // list in a `profile_unknown` refusal stays the authority.
        "Profiles: static-site (alias static), web-app, web-app-db, ai-agent-cpu; " +
        "an unknown profile returns the current list. All amounts are USD.",
      inputSchema: {
        app_profile: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "Invalid pricing profile key")
          .optional()
          .describe(
            "Pricing profile: static-site (or static), web-app, web-app-db, ai-agent-cpu. Omit for the default (web-app)."
          ),
        subdomain: z
          .string()
          .optional()
          .describe(
            "A live deployment's subdomain; returns its current billing projection and overrides app_profile"
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_profile, subdomain }) => {
      if (!subdomain && app_profile === GPU_CONTAINER_PROFILE) {
        return errorResponse(
          "profile_unavailable",
          `GPU containers are not offered, so the ${GPU_CONTAINER_PROFILE} profile has no estimate.`,
          "For a GPU virtual machine, list GPU profiles with varity_machines_list (include_profiles, gpu: true); varity_machines_create quotes the hourly price before creating it."
        );
      }
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
              const offered = Array.isArray(served)
                ? served.filter((profile) => profile !== GPU_CONTAINER_PROFILE)
                : [];
              const profiles = offered.length > 0 ? offered.join(", ") : "a profile from the tool description";
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

      if (!subdomain && isUnpricedStaticQuote(data)) {
        return unpricedStaticResponse(data, source, { app_profile, subdomain });
      }

      const projection = projectOwnerPricing(data);
      if (!projection) {
        return errorResponse(
          "pricing_unavailable",
          "Varity pricing is not available for that request.",
          "For a live deployment, confirm the app slug with varity_deploy_status."
        );
      }
      const estimateName = subdomain ?? data.profile ?? app_profile ?? "current default profile";
      const { unit, ...served } = projection;
      const amount = Object.values(served)[0] as number;
      const price = "monthly_max_usd" in projection
        ? monthlyMaximum(amount)
        : `${usd(amount)}/${unit} (USD)`;
      // The prorated monthly maximum's served note uses billing terms
      // ("reserved deployment, prorated"), so the summary says the same thing
      // in plain words (J-17).
      const plainNote = data.billing_model === PRORATED_MONTHLY_MAX
        ? "It is charged only for the time it runs, and never more than that in a month."
        : summaryNote(data);
      // A new Starter app may be the account's one free app (gateway free-app
      // admission: plan starter). Said only for a plain Starter estimate.
      const freeStarter = !subdomain && isPlainStarter(data) ? " Free accounts can run one Starter app at no charge." : "";
      const summary = `${String(estimateName)}: ${price}.${plainNote ? ` ${plainNote}` : ""}${freeStarter}`;

      return successResponse(
        {
          source,
          input: { app_profile, subdomain },
          // Explicit whitelist of the pricing response fields this tool renders.
          // Never spread the raw response into the tool result.
          profile: data.profile,
          currency: data.currency,
          ...served,
          // A static quote priced for the account: whose quote and its count.
          quote_scope: data.quote_scope,
          active_static_sites: data.active_static_sites,
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
