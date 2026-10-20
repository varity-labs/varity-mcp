import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { publicApiGet, VarityPublicApiError } from "../utils/public-api.js";
import { errorResponse, successResponse } from "../utils/responses.js";
import { INFRASTRUCTURE } from "../utils/config.js";

const BALANCE_PATH = "/api/credits/balance";
const BILLING_URL = `${INFRASTRUCTURE.DASHBOARD}/billing`;

/** Preserve exact served USD amounts, including sub-cent and large balances. */
function usdAmount(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  const fraction = (amount % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${amount / 100_000_000n}.${fraction}`;
}

function unavailable() {
  return errorResponse("balance_unavailable", "Your Varity balance is unavailable right now.", `Retry varity_balance, or see ${BILLING_URL}.`);
}

export function registerBalanceTool(server: McpServer): void {
  server.registerTool("varity_balance", {
    title: "Account Balance",
    description: "Read your Varity balance in USD: available, reserved, and owed. Amounts are exact decimal USD strings. Use before deploying or when asked how much balance remains. An unavailable read is never reported as zero.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const body = await publicApiGet<Record<string, unknown>>(BALANCE_PATH);
      const available = usdAmount(body.availableE8);
      const reserved = usdAmount(body.reservedE8);
      const debt = usdAmount(body.debtE8);
      if (available === null || reserved === null || debt === null) return unavailable();
      return successResponse({
        currency: "USD",
        available_usd: available,
        reserved_usd: reserved,
        debt_usd: debt,
        source: `varity_public_api:${BALANCE_PATH}`,
      }, `Available $${available}, reserved $${reserved}, owed $${debt} (USD).`);
    } catch (error) {
      if (error instanceof VarityPublicApiError && (error.code === "NOT_AUTHENTICATED" || error.status === 401 || error.status === 403)) {
        return errorResponse(error.code, error.message, error.action);
      }
      return unavailable();
    }
  });
}
