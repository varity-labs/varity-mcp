/**
 * Unified credit billing (varity-engineering#225, varity-mcp#79). The owner
 * (billing-meter `CREDIT_POLICY`) serves `credit_policy` in `GET /api/pricing`;
 * the MCP reads the credit rate and the billing error-code list from it and
 * restates neither:
 * - every USD estimate carries its credit equivalent at the served rate, or
 *   says credits are unavailable when the policy cannot be read;
 * - a 402/503 whose code the policy lists gets MCP copy; every other code,
 *   including one the policy does not list, passes through unchanged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env["VARITY_GATEWAY_URL"] = "https://gw.test";
process.env["VARITY_API_KEY"] = "api-key";

/** The served `credit_policy` block, verbatim from varity-engineering#225 (2026-10-18, incl. the enterprise and static amendments). */
const CREDIT_POLICY = {
  version: "2026-10-18",
  creditsPerUsd: 100,
  plans: [{ id: "free", priceUsd: 0, monthlyCredits: 500 },
          { id: "core", priceUsd: 20, monthlyCredits: 2000 },
          { id: "pro", priceUsd: 100, monthlyCredits: 10000 },
          { id: "business", priceUsd: 500, monthlyCredits: 50000 },
          { id: "enterprise", priceUsd: null, monthlyCredits: null, contactSales: true, minimumMonthlySpendUsd: 5000 }],
  free: { monthlyCredits: 500, dailyAiCredits: 50, promoCategories: ["ai_chat", "ai_build", "static"] },
  rollover: { subscriptionCycles: 1 },
  topUp: { minimumUsd: 20, presetsUsd: [20, 100, 500], expiresAfterMonths: null },
  static: { freeSites: 3, extraSiteMonthlyCredits: 100 },
  spendCategories: ["ai_chat", "ai_build", "ai_api", "static", "app", "cpu", "gpu"],
  errorCodes: ["insufficient_credits", "daily_free_limit_reached", "spending_limit_reached", "subscription_required", "wallet_frozen", "payment_method_shared", "quote_expired", "billing_unavailable"],
};

const api = await import("../dist/utils/public-api.js");
const { registerCostCalculatorTool } = await import("../dist/tools/cost-calculator.js");
const { registerMachinesTools } = await import("../dist/tools/machines.js");

/** Routes `GET /api/pricing` to `pricing` ([status, body]) and every other call to `other`. */
function stubGateway(pricing, other) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const [status, payload] = new URL(url).pathname === "/api/pricing" ? pricing : other;
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const SERVED = [200, { credit_policy: CREDIT_POLICY }];
const payload = (response) => JSON.parse(response.content[0].text);

async function rejection(pricing, status, body) {
  const stub = stubGateway(pricing, [status, body]);
  try {
    await api.publicApiRequest("POST", "/api/deployments", { body: {} });
  } catch (err) {
    assert.ok(err instanceof api.VarityPublicApiError);
    return err;
  } finally {
    stub.restore();
  }
  assert.fail("expected the request to reject");
}

async function costTool(pricing, other, args) {
  let handler;
  registerCostCalculatorTool({ registerTool: (_name, _config, fn) => { handler = fn; } });
  const stub = stubGateway(pricing, other);
  try {
    return payload(await handler(args));
  } finally {
    stub.restore();
  }
}

test("each served billing code becomes a clear user-facing error with an action", async () => {
  const messages = new Set();
  for (const code of CREDIT_POLICY.errorCodes) {
    const status = code === "billing_unavailable" ? 503 : 402;
    const err = await rejection(SERVED, status, { code, message: "raw server text" });
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    assert.notEqual(err.message, "raw server text", `${code} has MCP copy`);
    assert.ok(err.action, `${code} has an action`);
    messages.add(err.message);
  }
  assert.equal(messages.size, CREDIT_POLICY.errorCodes.length, "each served code has its own message");
});

test("spending_limit_reached says the monthly spending limit was reached", async () => {
  const err = await rejection(SERVED, 402, { code: "spending_limit_reached" });
  assert.match(err.message, /monthly spending limit/i);
});

test("503 billing_unavailable in the `{error: code}` shape reads as unavailable, not a balance problem", async () => {
  const err = await rejection(SERVED, 503, { error: "billing_unavailable" });
  assert.equal(err.code, "billing_unavailable");
  assert.match(err.message, /temporarily unavailable/i);
  assert.doesNotMatch(err.message, /balance|insufficient/i);
});

test("the served list decides: an unlisted code passes through, a listed code without copy gets the generic billing copy", async () => {
  const narrowed = [200, { credit_policy: { ...CREDIT_POLICY, errorCodes: ["insufficient_credits", "new_billing_code"] } }];
  const unlisted = await rejection(narrowed, 402, { code: "quote_expired", message: "server text", action: "server action" });
  assert.equal(unlisted.message, "server text");
  assert.equal(unlisted.action, "server action");
  const uncopied = await rejection(narrowed, 402, { code: "new_billing_code", message: "server text" });
  assert.equal(uncopied.code, "new_billing_code");
  assert.match(uncopied.message, /billing/i);
  assert.notEqual(uncopied.message, "server text");
});

test("legacy and non-billing codes pass through unchanged; producers own the legacy rename", async () => {
  const legacy = await rejection(SERVED, 402, { code: "insufficient_gateway_balance", message: "server text" });
  assert.equal(legacy.code, "insufficient_gateway_balance");
  assert.equal(legacy.message, "server text");
  const prose = await rejection(SERVED, 400, { error: "valid ownerId is required" });
  assert.equal(prose.code, "VARITY_API_ERROR");
});

test("an unreadable policy leaves billing errors as the server sent them", async () => {
  for (const pricing of [[503, {}], [200, {}], [200, { credit_policy: { ...CREDIT_POLICY, creditsPerUsd: "100" } }]]) {
    const err = await rejection(pricing, 402, { code: "insufficient_credits", message: "server text" });
    assert.equal(err.code, "insufficient_credits");
    assert.equal(err.message, "server text");
  }
});

test("estimate shows credits at the served rate next to USD, in text and data alike", async () => {
  const out = await costTool(SERVED, [200, { profile: "starter", fixed_monthly_cost_usd: 12.29 }], {});
  assert.equal(out.data.fixed_monthly_cost_usd, 12.29);
  assert.equal(out.data.fixed_monthly_cost_credits, 1229);
  assert.match(out.message, /\$12\.29\/mo \(1,229 credits\)/);

  const half = [200, { credit_policy: { ...CREDIT_POLICY, creditsPerUsd: 50 } }];
  const halfRate = await costTool(half, [200, { fixed_monthly_cost_usd: 12.29 }], {});
  assert.equal(halfRate.data.fixed_monthly_cost_credits, 614.5);
});

test("hourly deployment billing shows fractional credits without float drift", async () => {
  const deployment = [200, { deployment: { id: "d-1", billing: { hourly_cost_usd: 0.29 } } }];
  const out = await costTool(SERVED, deployment, { subdomain: "my-app" });
  assert.equal(out.data.hourly_cost_credits, 29);
  const fractional = await costTool(SERVED, [200, { deployment: { id: "d-1", billing: { hourly_cost_usd: 0.0137 } } }], { subdomain: "my-app" });
  assert.equal(fractional.data.hourly_cost_credits, 1.37);
  assert.match(fractional.message, /\(1\.37 credits\)/);
});

test("an unreadable policy keeps the USD estimate and says credits are unavailable", async () => {
  const out = await costTool([503, {}], [200, { fixed_monthly_cost_usd: 12.29 }], {});
  assert.equal(out.success, true);
  assert.equal(out.data.fixed_monthly_cost_usd, 12.29);
  assert.equal(out.data.fixed_monthly_cost_credits, null);
  assert.match(out.message, /\$12\.29\/mo \(credits unavailable\)/);
});

test("machine create surfaces a served billing code to the user", async () => {
  const handlers = {};
  registerMachinesTools({ registerTool: (name, _config, fn) => { handlers[name] = fn; } });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const [status, body] = path === "/api/pricing" ? SERVED
      : path === "/api/pricing/machine-quote" ? [200, { quote_token: "aq1.token-abcdefgh" }]
      : [402, { code: "quote_expired" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    const out = payload(await handlers.varity_machines_create({
      name: "dev-box", profile_id: "mp-0123456789abcdef01234567", os_image: "os-ubuntu-24-04-0123456789ab",
      ssh_public_key: "ssh-ed25519 AAAA user@host",
    }));
    assert.equal(out.success, false);
    assert.equal(out.error.code, "quote_expired");
    assert.match(out.error.suggestion, /fresh quote/i);
  } finally {
    globalThis.fetch = original;
  }
});
