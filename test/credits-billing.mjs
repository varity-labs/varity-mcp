/**
 * Unified credit billing (varity-engineering#225, varity-mcp#79):
 * - every USD estimate carries its exact credit equivalent (100 credits = $1),
 *   computed from the decimal amount with integer math, never float scaling;
 * - the closed 402 codes and 503 `billing_unavailable` reach the user as clear
 *   messages through the one public-API client, so deploy and machine tools
 *   both surface them; legacy `insufficient_gateway_balance` still maps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env["VARITY_GATEWAY_URL"] = "https://gw.test";
process.env["VARITY_API_KEY"] = "api-key";

const api = await import("../dist/utils/public-api.js");
const { usdToCredits, registerCostCalculatorTool } = await import("../dist/tools/cost-calculator.js");
const { registerMachinesTools } = await import("../dist/tools/machines.js");

function stubSequence(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const [status, payload] = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const payload = (response) => JSON.parse(response.content[0].text);

async function rejection(status, body) {
  const stub = stubSequence([[status, body]]);
  try {
    await api.publicApiRequest("POST", "/api/deployments", { body: {} });
  } catch (err) {
    return err;
  } finally {
    stub.restore();
  }
  assert.fail("expected the request to reject");
}

async function costTool(args) {
  let handler;
  registerCostCalculatorTool({ registerTool: (_name, _config, fn) => { handler = fn; } });
  return payload(await handler(args));
}

test("usdToCredits is exact decimal math at 100 credits per dollar", () => {
  assert.equal(usdToCredits(25), 2500);
  assert.equal(usdToCredits(0.07), 7); // 0.07 * 100 = 7.000000000000001 in floats
  assert.equal(usdToCredits(0.29), 29); // 0.29 * 100 = 28.999999999999996 in floats
  assert.equal(usdToCredits(0.0137), 1.37);
  assert.equal(usdToCredits(1234.5678), 123456.78);
  assert.equal(usdToCredits(0.00005), 0.01); // half-up at the hundredth of a credit
  assert.equal(usdToCredits(0.000049), 0);
  assert.equal(usdToCredits(1e-7), 0);
  assert.equal(usdToCredits(0), 0);
});

test("pre-deploy estimate shows credits next to USD in text and data", async () => {
  const stub = stubSequence([[200, { profile: "starter", currency: "USD", fixed_monthly_cost_usd: 12.29 }]]);
  try {
    const out = await costTool({});
    assert.equal(out.success, true);
    assert.equal(out.data.fixed_monthly_cost_usd, 12.29);
    assert.equal(out.data.fixed_monthly_cost_credits, 1229);
    assert.match(out.message, /\$12\.29\/mo \(1,229 credits\)/);
  } finally {
    stub.restore();
  }
});

test("hourly deployment billing shows fractional credits next to USD", async () => {
  const stub = stubSequence([[200, { deployment: { id: "d-1", billing: { currency: "USD", hourly_cost_usd: 0.0137 } } }]]);
  try {
    const out = await costTool({ subdomain: "my-app" });
    assert.equal(out.data.hourly_cost_usd, 0.0137);
    assert.equal(out.data.hourly_cost_credits, 1.37);
    assert.match(out.message, /\$0\.0137\/hour \(1\.37 credits\)/);
  } finally {
    stub.restore();
  }
});

const BILLING_CODES = [
  "insufficient_credits",
  "daily_free_limit_reached",
  "subscription_required",
  "wallet_frozen",
  "payment_method_shared",
  "quote_expired",
  "spending_limit_reached",
];

test("each closed 402 code becomes a clear user-facing error with an action", async () => {
  const messages = new Set();
  for (const code of BILLING_CODES) {
    const err = await rejection(402, { code, message: "raw server text", retryable: false });
    assert.ok(err instanceof api.VarityPublicApiError);
    assert.equal(err.code, code);
    assert.equal(err.status, 402);
    assert.notEqual(err.message, "raw server text");
    assert.ok(err.action && err.action.length > 0, `${code} has an action`);
    messages.add(err.message);
  }
  assert.equal(messages.size, BILLING_CODES.length, "each code has its own message");
});

test("spending_limit_reached says the monthly spending limit was reached", async () => {
  const err = await rejection(402, { code: "spending_limit_reached" });
  assert.equal(err.code, "spending_limit_reached");
  assert.match(err.message, /monthly spending limit/i);
});

test("the frozen `{error: code}` body shape is recognised", async () => {
  const err = await rejection(402, { error: "daily_free_limit_reached" });
  assert.equal(err.code, "daily_free_limit_reached");
});

test("503 billing_unavailable is reported as unavailable, never as a balance problem", async () => {
  const err = await rejection(503, { error: "billing_unavailable" });
  assert.equal(err.code, "billing_unavailable");
  assert.equal(err.status, 503);
  assert.match(err.message, /temporarily unavailable/i);
  assert.doesNotMatch(err.message, /balance|insufficient/i);
});

test("legacy insufficient_gateway_balance maps to insufficient_credits", async () => {
  const legacy = await rejection(402, { code: "insufficient_gateway_balance", message: "x" });
  const current = await rejection(402, { code: "insufficient_credits" });
  assert.equal(legacy.code, "insufficient_credits");
  assert.equal(legacy.message, current.message);
  assert.equal(legacy.action, current.action);
});

test("unrelated error codes pass through unchanged", async () => {
  const err = await rejection(402, { code: "billing_or_credit_required", message: "server text", action: "server action" });
  assert.equal(err.code, "billing_or_credit_required");
  assert.equal(err.message, "server text");
  assert.equal(err.action, "server action");
  const human = await rejection(400, { error: "valid ownerId is required" });
  assert.equal(human.code, "VARITY_API_ERROR");
});

test("machine create surfaces a 402 billing code to the user", async () => {
  const stub = stubSequence([
    [200, { quote_token: "aq1.token-abcdefgh", hourly_usd: 0.05 }],
    [402, { code: "quote_expired" }],
  ]);
  try {
    const handlers = {};
    registerMachinesTools({ registerTool: (name, _config, fn) => { handlers[name] = fn; } });
    const out = payload(await handlers.varity_machines_create({
      name: "dev-box", profile_id: "mp-0123456789abcdef01234567", os_image: "os-ubuntu-24-04-0123456789ab",
      ssh_public_key: "ssh-ed25519 AAAA user@host",
    }));
    assert.equal(out.success, false);
    assert.equal(out.error.code, "quote_expired");
    assert.match(out.error.suggestion, /retry/i);
  } finally {
    stub.restore();
  }
});
