/**
 * What an AI agent needs from the MCP to succeed without guessing, from the
 * clean-environment journey D (2026-10-20, evidence
 * launch-journey-20261019/e2e-D-mcp). Each test names the friction it closes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env["VARITY_GATEWAY_URL"] = "https://gw.test";
process.env["VARITY_API_KEY"] = "api-key";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");
const api = await import("../dist/utils/public-api.js");

const payload = (response) => JSON.parse(response.content[0].text);

/** Routes each request by pathname to `[status, body]`; records every call. */
function stubGateway(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, url: String(url), init });
    const [status, body] = routes[path] ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function connect() {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "journey-d", version: "1" });
  await client.connect(clientSide);
  return client;
}

async function call(routes, name, args = {}) {
  const client = await connect();
  const stub = stubGateway(routes);
  try {
    return { out: payload(await client.callTool({ name, arguments: args })), calls: stub.calls };
  } finally {
    stub.restore();
    await client.close();
  }
}

// ── 1. USD only ─────────────────────────────────────────────────────────────

/** Owner API identifiers that contain the word; they are codes, not copy. */
const API_IDENTIFIERS = /credit_policy|insufficient_credits|credit-billing|useCreditAccount/g;

test("USD only: no customer-visible string in the source says credit", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!path.endsWith(".ts")) continue;
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const literal of code.match(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g) ?? []) {
        if (/credit/i.test(literal.replace(API_IDENTIFIERS, ""))) offenders.push(`${path}: ${literal.slice(0, 80)}`);
      }
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(offenders, []);
});

test("USD only: tools/list text and schemas never say credit", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  assert.doesNotMatch(JSON.stringify(tools), /credit/i);
});

test("USD only: every billing refusal speaks USD, not credits", async () => {
  const codes = ["insufficient_credits", "daily_free_limit_reached", "payment_method_shared", "new_code"];
  for (const code of codes) {
    const stub = stubGateway({
      "/api/pricing": [200, { credit_policy: { errorCodes: codes } }],
      "/api/deployments": [402, { code, message: "Not enough credits." }],
    });
    try {
      await api.publicApiRequest("POST", "/api/deployments", { body: {} });
      assert.fail("expected a refusal");
    } catch (err) {
      assert.equal(err.code, code, "the owner's code passes through");
      assert.doesNotMatch(`${err.message} ${err.action}`, /credit/i);
    } finally {
      stub.restore();
    }
  }
});

// ── 2. Balance ──────────────────────────────────────────────────────────────

const ACCOUNT = {
  observedAt: "2026-10-20T03:00:00.000Z",
  plan: { id: "core", status: "active" },
  credits: { availableE8: "1234560000", available: 1234.56, reservedE8: "8606000000", reserved: 8606, debtE8: "0", debt: 0 },
  access: "active",
};

test("varity_balance reads the portal's account and reports USD from the exact e8 strings", async () => {
  const { out, calls } = await call({ "/api/billing/account": [200, ACCOUNT] }, "varity_balance");
  assert.equal(out.success, true);
  assert.deepEqual(calls.map((c) => c.path), ["/api/billing/account"]);
  assert.equal(out.data.available_usd, 12.3456);
  assert.equal(out.data.reserved_usd, 86.06);
  assert.equal(out.data.debt_usd, 0);
  assert.equal(out.data.currency, "USD");
  assert.match(out.message, /Available \$12\.35, reserved \$86\.06/);
  assert.doesNotMatch(JSON.stringify(out), /credit/i);
});

test("varity_balance never turns a missing amount or a refused read into $0", async () => {
  const partial = await call({ "/api/billing/account": [200, { ...ACCOUNT, credits: { available: 0 } }] }, "varity_balance");
  assert.equal(partial.out.data.available_usd, "unavailable");
  assert.equal(partial.out.data.reserved_usd, "unavailable");

  const refused = await call({ "/api/billing/account": [401, { error: "Invalid or expired token" }] }, "varity_balance");
  assert.equal(refused.out.success, false);
  assert.equal(refused.out.error.code, "balance_unavailable");
  assert.match(refused.out.error.suggestion, /developer\.store\.varity\.so\/dashboard\/billing/);
});

// ── 3. One canonical id ─────────────────────────────────────────────────────

/** `varity_deploy_status` for one served row (the tool path an agent uses). */
async function statusOf(row) {
  const { out } = await call({ [`/api/deployments/${row.id}`]: [200, { deployment: row }] }, "varity_deploy_status", { deployment_id: row.id });
  return out;
}

test("status returns the same id varity_deploy returned, before and after go-live", async () => {
  const op = "1ce9757d-9818-4a0d-ba3f-0edd7b496bc0";
  const deploying = await statusOf({ id: op, operation_deployment_id: op, status: "deploying" });
  const live = await statusOf({ id: "6a2bfaaf-adf6-4fb9-a891-72b3e68155c1", operation_deployment_id: op, status: "live" });
  assert.equal(deploying.data.deployment.id, op);
  assert.equal(live.data.deployment.id, op);
  assert.match(live.message, new RegExp(op));
  const legacy = await statusOf({ id: "legacy-1", operation_deployment_id: null, status: "live" });
  assert.equal(legacy.data.deployment.id, "legacy-1");
});

// ── 4. Status truth ─────────────────────────────────────────────────────────

test("a pending URL is omitted and said in words, never 'unknown'", async () => {
  const out = await statusOf({ id: "op-1", operation_deployment_id: "op-1", app_name: "vm-1", status: "live", created_at: "2026-10-18T23:54:36Z", billing: null });
  assert.equal("url" in out.data.deployment, false);
  assert.equal("runtime" in out.data.deployment, false);
  assert.doesNotMatch(JSON.stringify(out), /unknown/);
  assert.match(out.message, /URL not assigned yet/);
});

test("an unobserved billing state reports month-to-date as unavailable, not $0", async () => {
  const vm = await statusOf({
    id: "vm", status: "live", billing: { state: null, currency: "USD", accrued_this_month_usd: 0, active_seconds_this_month: null },
  });
  assert.equal(vm.data.deployment.billing.accrued_this_month_usd, "unavailable");
  const app = await statusOf({ id: "app", status: "live", billing: { state: "active", accrued_this_month_usd: 0.28 } });
  assert.equal(app.data.deployment.billing.accrued_this_month_usd, 0.28);
});

// ── 5. Delete semantics ─────────────────────────────────────────────────────

test("delete says it returns at acceptance and tells the agent what to poll", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const del = tools.find((t) => t.name === "varity_delete_deployment");
  assert.doesNotMatch(del.description, /track it until/i);
  assert.match(del.description, /does not wait/);
  assert.match(del.description, /billing\.state stopped/);

  const { out } = await call({
    "/api/deployments/app-1": [202, { status: "deleting", run_id: "run-1" }],
    "/api/deployments/runs/run-1": [200, { public_status: "deleting" }],
  }, "varity_delete_deployment", { deployment: "app-1" });
  assert.equal(out.data.public_status, "deleting");
  assert.match(out.message, /Poll varity_deploy_status .* billing\.state is stopped/);
});

// ── 6. Schema accuracy ──────────────────────────────────────────────────────

test("an undeclared argument is refused with the accepted names", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "varity_deploy_status", arguments: { bogus: 1 } });
  await client.close();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown argument\. varity_deploy_status accepts only: deployment_id, path, limit/);
});

test("the cost calculator lists its profiles and estimates before sign-in", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const cost = tools.find((t) => t.name === "varity_cost_calculator");
  assert.match(JSON.stringify(cost), /static-site/);

  const saved = process.env["VARITY_API_KEY"];
  delete process.env["VARITY_API_KEY"];
  try {
    const { out, calls } = await call({
      "/api/pricing": [200, { profile: "static-site", currency: "USD", monthly_max_usd: 0, billing_model: "free_static" }],
    }, "varity_cost_calculator", { app_profile: "static" });
    assert.equal(out.success, true);
    assert.equal(out.data.monthly_max_usd, 0);
    assert.equal(calls[0].url, "https://gw.test/api/pricing?profile=static");
    assert.equal(calls[0].init.headers.Authorization, undefined, "a pre-deploy estimate needs no key");
  } finally {
    process.env["VARITY_API_KEY"] = saved;
  }

  const unknown = await call({
    "/api/pricing": [400, { code: "profile_unknown", error: "Unknown pricing profile", profiles: ["static-site", "web-app"] }],
  }, "varity_cost_calculator", { app_profile: "nope" });
  assert.equal(unknown.out.error.code, "profile_unknown");
  assert.match(unknown.out.error.suggestion, /static-site, web-app/);
});

test("errors name tools the agent can call, never raw HTTP routes", async () => {
  const { out } = await call({
    "/api/deployments/site/logs": [409, {
      code: "runtime_not_started",
      message: "This is a static site: it has no runtime logs.",
      action: "Read run_id from GET /api/deployments/{id}, then GET /api/deployments/runs/{run_id}.",
    }],
  }, "varity_deploy_logs", { deployment: "site" });
  assert.doesNotMatch(out.error.suggestion, /\/api\//);
  assert.match(out.error.suggestion, /varity_deploy_status/);
});

// ── 7. Key wording ──────────────────────────────────────────────────────────

test("a rejected key says 'deploy key' and where to create one", async () => {
  const { out } = await call({
    "/api/deployments": [401, { code: "invalid_api_key", message: "The API key is invalid or revoked.", action: "Create a new API key in the Developer Portal and retry." }],
  }, "varity_deploy_status");
  assert.equal(out.error.code, "invalid_api_key");
  assert.match(out.error.suggestion, /deploy key at https:\/\/developer\.store\.varity\.so\/dashboard\/settings\?tab=api-keys/);
  assert.doesNotMatch(`${out.error.message} ${out.error.suggestion}`, /API key/);
});
