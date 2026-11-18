import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isRemoteCall, publicApiGet, VarityPublicApiError } from "../utils/public-api.js";
import { errorResponse, successResponse } from "../utils/responses.js";
import { INFRASTRUCTURE } from "../utils/endpoints.js";

const BALANCE_PATH = "/api/credits/balance";
const BILLING_URL = `${INFRASTRUCTURE.DASHBOARD}/billing`;

/** Preserve exact served USD amounts, including sub-cent and large balances. */
function usdAmount(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  const fraction = (amount % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${amount / 100_000_000n}.${fraction}`;
}

/** An exact served E8 amount rounded to cents for the message; a positive sub-cent amount is "<$0.01". */
function cents(value: string): string {
  const amount = BigInt(value);
  if (amount > 0n && amount < 500_000n) return "<$0.01";
  const rounded = (amount + 500_000n) / 1_000_000n;
  return `$${(rounded / 100n).toLocaleString("en-US")}.${(rounded % 100n).toString().padStart(2, "0")}`;
}

function unavailable() {
  // A hosted call names no billing link (explain-only copy).
  const action = isRemoteCall() ? "Retry varity_balance." : `Retry varity_balance, or see ${BILLING_URL}.`;
  return errorResponse("balance_unavailable", "Your Varity balance is unavailable right now.", action);
}

export function registerBalanceTool(server: McpServer): void {
  server.registerTool("varity_balance", {
    title: "Account Balance",
    description: "Read your Varity balance in USD: available, set aside for running apps, and owed. reserved_usd is the amount set aside for the user's running apps (their monthly maximums), not a measure of funded backing. The data carries exact decimal USD strings; the message rounds to cents. Use before deploying or when asked how much balance remains. An unavailable read is never reported as zero.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try {
      const body = await publicApiGet<Record<string, unknown>>(BALANCE_PATH);
      const available = usdAmount(body.availableE8);
      const authorizationMaximum = usdAmount(body.reservedE8);
      const debt = usdAmount(body.debtE8);
      if (available === null || authorizationMaximum === null || debt === null) return unavailable();
      return successResponse({
        currency: "USD",
        available_usd: available,
        reserved_usd: authorizationMaximum,
        debt_usd: debt,
        source: `varity_public_api:${BALANCE_PATH}`,
      }, `Available ${cents(body.availableE8 as string)}, set aside for your running apps ${cents(body.reservedE8 as string)} (released within a few minutes after an app stops), owed ${cents(body.debtE8 as string)} (USD).`);
    } catch (error) {
      if (error instanceof VarityPublicApiError && (error.code === "NOT_AUTHENTICATED" || error.status === 401 || error.status === 403)) {
        return errorResponse(error.code, error.message, error.action);
      }
      return unavailable();
    }
  });
}
