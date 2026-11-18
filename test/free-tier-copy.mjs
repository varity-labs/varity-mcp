/**
 * D6 G5 (free tier): the cost estimate for a Starter app says a Free account
 * can run one at no charge, and a billing decline in varity_deploy_status
 * reads in plain words with where to fix it (local: the Billing link; hosted:
 * no link or purchase step).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "api-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-free-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");
const { latestRunFailure } = await import("../dist/tools/deploy-status.js");
const { runInCallContext } = await import("../dist/utils/public-api.js");

const FREE_LINE = "Free accounts can run one Starter app at no charge.";
const BILLING = "https://developer.store.varity.so/dashboard/billing";

async function call(name, args, routes) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "free", version: "1" });
  await client.connect(clientSide);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const [status, body] = routes[u.pathname + u.search] ?? routes[u.pathname] ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    return JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

const preset = (id) => ({ id, name: id, vcpu: 1, memory_gb: 1, ephemeral_gb: 2, endpoints: 1, monthly_max_usd: 7 });
const estimate = (extra) => ({ profile: "x", currency: "USD", monthly_max_usd: 7, billing_model: "reserved_monthly_max_prorated", billing_note: "Up to $7/mo", mode: "dynamic", verified: true, ...extra });

test("a Starter estimate says a Free account runs one at no charge", async () => {
  const out = await call("varity_cost_calculator", { app_profile: "web-app" }, { "/api/pricing": [200, estimate({ preset: preset("starter") })] });
  assert.ok(out.message.endsWith(` ${FREE_LINE}`), out.message);
});

test("no free line for a bigger plan, an attached database, or a live deployment", async () => {
  const growth = await call("varity_cost_calculator", { app_profile: "ai-agent-cpu" }, { "/api/pricing": [200, estimate({ preset: preset("growth") })] });
  const db = await call("varity_cost_calculator", { app_profile: "web-app-db" }, { "/api/pricing": [200, estimate({ preset: preset("starter"), attached_services: [{ id: "postgres" }] })] });
  const live = await call("varity_cost_calculator", { subdomain: "app" }, { "/api/deployments/app": [200, { deployment: { id: "app", billing: { currency: "USD", fixed_monthly_cost_usd: 7 } } }] });
  for (const out of [growth, db, live]) assert.doesNotMatch(out.message, /no charge/, out.message);
});

const decline = (diagnostic_code, action_code) => ({ classification: "expected_rejection", stage: "admission", code: "billing_declined", action_code, diagnostic_code });
const CASES = [
  [decline("payment_method_required", "add_payment_method"), "Varity needs a payment method on file before it can run this app"],
  [decline("insufficient_prepaid_balance", "add_funds"), "Your Varity balance is too low for this request"],
  [decline("prepaid_monthly_limit_reached", "check_configuration"), "Your monthly spending limit on Varity has been reached"],
  [decline("prepaid_balance_frozen", "contact_support"), "Billing on this Varity account is frozen, so new charges are refused"],
  [decline("payment_method_shared", "add_payment_method"), "This payment method is already used by another Varity account, so the free allowance does not apply"],
  [decline("something_new", "add_funds"), "Varity billing declined this deploy"],
];

test("a billing decline in deploy_status is plain words plus the Billing link", async () => {
  for (const [outcome, plain] of CASES) {
    const row = { id: "op-b", operation_deployment_id: "op-b", status: "failed", run_id: "run-b", outcome };
    const out = await call("varity_deploy_status", { deployment_id: "op-b" }, {
      "/api/deployments/op-b": [200, { deployment: row }],
      "/api/deployments/runs/run-b": [200, { public_status: "failed", outcome }],
    });
    assert.ok(out.message.startsWith(`Deployment op-b: ${plain}, so the app is not online.`), out.message);
    if (outcome.diagnostic_code === "prepaid_balance_frozen") assert.match(out.message, /Contact Varity support/);
    else assert.ok(out.message.includes(BILLING), out.message);
    assert.doesNotMatch(out.message, /could not accept this deploy as it is set up|billing_declined|_required|add_funds/);
  }
});

test("a hosted call explains the decline without a link or purchase step", () => {
  const context = { credentials: async () => null, transport: "streamable_http", clientInfo: () => undefined };
  for (const [outcome, plain] of CASES) {
    const text = runInCallContext(context, () => latestRunFailure({ id: "op-b", status: "failed", run_status: "failed", outcome }));
    assert.ok(text.startsWith(`${plain}, so the app is not online.`), text);
    assert.doesNotMatch(text, /https?:\/\/|\/billing|add funds|choose a plan|upgrade/i, text);
  }
});
