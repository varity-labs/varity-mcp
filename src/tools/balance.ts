import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getBillingAccount, VarityPublicApiError } from "../utils/public-api.js";
import { INFRASTRUCTURE } from "../utils/config.js";

/**
 * `varity_balance` → `GET /api/billing/account`, the one prepaid account the
 * portal Billing page reads (portal `useCreditAccount` / `parseCreditAccount`).
 *
 * The MCP computes nothing: each amount is the served exact USD-e8 string
 * divided by 1e8, the same projection the portal makes. A missing or
 * malformed amount is reported as `"unavailable"`, never as 0 (a dependency
 * failure is not an empty balance).
 */

const BILLING_URL = `${INFRASTRUCTURE.DASHBOARD}/billing`;
export const UNAVAILABLE = "unavailable" as const;

/** An exact non-negative USD-e8 decimal string as USD, or `"unavailable"`. */
export function e8AsUsd(value: unknown): number | typeof UNAVAILABLE {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) / 1e8 : UNAVAILABLE;
}

function field(source: unknown, key: string): unknown {
  return source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;
}

/** The served account projected to USD-only customer fields. */
export function projectBalance(account: Record<string, unknown>) {
  // The wire block is named `credits` but its *E8 strings are exact USD.
  const amounts = account.credits;
  const plan = account.plan;
  return {
    currency: "USD",
    available_usd: e8AsUsd(field(amounts, "availableE8")),
    reserved_usd: e8AsUsd(field(amounts, "reservedE8")),
    debt_usd: e8AsUsd(field(amounts, "debtE8")),
    plan: typeof field(plan, "id") === "string" ? field(plan, "id") : UNAVAILABLE,
    plan_status: typeof field(plan, "status") === "string" ? field(plan, "status") : UNAVAILABLE,
    access: typeof account.access === "string" ? account.access : UNAVAILABLE,
    observed_at: typeof account.observedAt === "string" ? account.observedAt : null,
  };
}

const usd = (value: number | typeof UNAVAILABLE) =>
  value === UNAVAILABLE ? UNAVAILABLE : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function registerBalanceTool(server: McpServer): void {
  server.registerTool(
    "varity_balance",
    {
      title: "Account Balance",
      description:
        "Read the Varity account's balance in USD: available, reserved for running deployments, and any amount owed, " +
        "plus the plan. Use when a developer asks 'what's my balance?', 'how much do I have left?', or before a deploy " +
        "that may be refused for balance. Reads the same account the portal Billing page shows; amounts the service " +
        "does not serve are reported as \"unavailable\", never 0.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const balance = projectBalance(await getBillingAccount());
        return successResponse(
          { ...balance, source: "varity_public_api:/api/billing/account" },
          `Available ${usd(balance.available_usd)}, reserved ${usd(balance.reserved_usd)} (USD).`
        );
      } catch (err) {
        if (err instanceof VarityPublicApiError && err.code === "NOT_AUTHENTICATED") {
          return errorResponse(err.code, err.message, err.action);
        }
        if (err instanceof VarityPublicApiError && (err.status === 401 || err.status === 403)) {
          // The account read authenticates portal sessions; a valid deploy key
          // is refused there, which says nothing about the balance itself.
          return errorResponse(
            "balance_unavailable",
            "The balance is unavailable through a deploy key: the Varity billing account read accepts only a signed-in portal session.",
            `See the balance at ${BILLING_URL}.`
          );
        }
        if (err instanceof VarityPublicApiError) {
          return errorResponse(
            "balance_unavailable",
            `The balance is unavailable right now: ${err.message}`,
            `Retry varity_balance in a minute, or see the balance at ${BILLING_URL}.`
          );
        }
        return errorResponse("balance_unavailable", "The balance is unavailable right now.", `Retry varity_balance, or see ${BILLING_URL}.`);
      }
    }
  );
}
