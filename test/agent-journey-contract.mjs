/**
 * What an AI agent needs from the MCP to succeed without guessing, from the
 * clean-environment journey D (2026-10-20, evidence
 * launch-journey-20261019/e2e-D-mcp). Each test names the friction it closes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["VARITY_GATEWAY_URL"] = "https://gw.test";
process.env["VARITY_DEPLOY_KEY"] = "api-key";
// An empty HOME, so the host's own ~/.varitykit/config.json never supplies a key.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "varity-journey-home-"));
delete process.env["VARITY_API_KEY"];

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
const API_IDENTIFIERS = /credit_policy|insufficient_credits|credit-billing|useCreditAccount|\/api\/credits\/balance/g;

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

  const saved = process.env["VARITY_DEPLOY_KEY"];
  delete process.env["VARITY_DEPLOY_KEY"];
  try {
    const { out, calls } = await call({
      "/api/pricing": [200, { profile: "static-site", currency: "USD", monthly_max_usd: 0, billing_model: "free_static" }],
    }, "varity_cost_calculator", { app_profile: "static" });
    assert.equal(out.success, true);
    assert.equal(out.data.monthly_max_usd, 0);
    assert.equal(calls[0].url, "https://gw.test/api/pricing?profile=static");
    assert.equal(calls[0].init.headers.Authorization, undefined, "a pre-deploy estimate needs no key");
  } finally {
    process.env["VARITY_DEPLOY_KEY"] = saved;
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

test("varity_login links the portal's Deploy keys tab, like every other key message", async () => {
  // A child process with an empty HOME, so the host's own varitykit login cannot answer first.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "varity-login-"));
  const script = `
    const { registerLoginTool } = await import(${JSON.stringify(new URL("../dist/tools/login.js", import.meta.url).href)});
    let handler; registerLoginTool({ registerTool: (_n, _c, fn) => { handler = fn; } });
    process.stdout.write((await handler({})).content[0].text);`;
  const text = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: home, CI: "true" },
  }).toString();
  assert.equal(JSON.parse(text).data.settings_url, "https://developer.store.varity.so/dashboard/settings?tab=api-keys");
});

test("varity_deploy app_name names both URL shapes the gateway serves", async () => {
  // Gateway publicUrlForRecord (services/deployment-registry.ts): a static site is
  // https://varity.app/<name>/, every app with a server is https://<name>.varity.app.
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const appName = tools.find((t) => t.name === "varity_deploy").inputSchema.properties.app_name.description;
  assert.match(appName, /https:\/\/varity\.app\/\{app_name\}\//);
  assert.match(appName, /https:\/\/\{app_name\}\.varity\.app/);
  assert.match(appName, /varity_deploy_status/);
});

test("the README license badge does not claim plain MIT", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /License: MIT|License-MIT/);
});

test("redeploy restarts the last release; deploying again with the same app_name ships new code", async () => {
  // deploy-api restart reconstructs the active release verbatim (sealed commit_sha);
  // a create with the same owner, name and workload shape advances that deployment
  // at the resolved HEAD (evidence phase2/a-plugin/23-redeploy-vs-deploy-source.md).
  const client = await connect();
  const { tools } = await client.listTools();
  const { messages } = await client.getPrompt({ name: "deploy", arguments: {} });
  await client.close();
  const describe = (name) => tools.find((t) => t.name === name).description;
  assert.match(describe("varity_redeploy"), /last successful release/);
  assert.match(describe("varity_redeploy"), /saved commit/);
  assert.match(describe("varity_redeploy"), /does not pick up new commits/);
  for (const text of [describe("varity_deploy"), messages[0].content.text]) {
    assert.match(text, /same app_name/);
    assert.match(text, /in place/);
  }
});

// ── 7. E1 live journeys (2026-11-17, evidence distribution-reverify-20261116/e1) ──

test("a private or unreachable repo names the working remedies, not 'the supplied token'", async () => {
  // Live 422 from the gateway; the local MCP supplies no git token (E1 journey 1).
  const { out } = await call({
    "/api/deployments": [422, {
      code: "source_repository_unreadable",
      message: "The repository could not be read. Check that it exists and that the supplied token grants access to it.",
      action: "Fix the request and retry. Deterministic rejections create no deployment or charge.",
    }],
  }, "varity_deploy", { repo_url: "https://github.com/acme/secret-app.git", app_name: "secret-app" });
  assert.equal(out.error.code, "source_repository_unreadable");
  assert.match(out.error.message, /private or unreachable/);
  assert.match(out.error.message, /cannot read private repositories from the MCP yet/);
  assert.doesNotMatch(out.error.message, /supplied token/);
  assert.match(out.error.suggestion, /gh repo edit acme\/secret-app --visibility public/);
  assert.match(out.error.suggestion, /container image/);
});

test("varity_create_repo still creates a private repository by default", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const visibility = tools.find((t) => t.name === "varity_create_repo").inputSchema.properties.visibility;
  assert.equal(visibility.default, "private");
});

test("redeploy on a static app says what redeploy restarts and how to ship, never 'retry later'", async () => {
  // Live: POST /api/deployments/<static app>/redeploy -> 409 retryable:false (E1 journey 3 step 8).
  for (const [status, body] of [
    [409, { code: "redeploy_failed", message: "Durable redeploy could not be accepted.", retryable: false }],
    [409, { code: "restart_unavailable", message: "This deployment cannot be restarted from saved configuration.", action: "Redeploy re-applies the saved configuration when a restart is not possible.", retryable: false }],
    [501, { code: "restart_unavailable", message: "A verified app restart is not available yet.", retryable: false }],
  ]) {
    const { out } = await call({ "/api/deployments/site-1/redeploy": [status, body] }, "varity_redeploy", { name: "site-1" });
    assert.equal(out.error.code, body.code);
    assert.match(out.error.message, /restarts dynamic and container apps only/);
    assert.match(out.error.suggestion, /static site/);
    assert.match(out.error.suggestion, /varity_deploy again with the same app_name/);
    assert.doesNotMatch(`${out.error.message} ${out.error.suggestion}`, /retry/i);
  }
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const description = tools.find((t) => t.name === "varity_redeploy").description;
  assert.match(description, /restarts dynamic and container apps only/);
  assert.match(description, /static site/);
});

test("a retryable redeploy refusal keeps its retry guidance", async () => {
  const { out } = await call({
    "/api/deployments/api-1/redeploy": [503, { code: "restart_unavailable", message: "The restart could not be accepted right now.", action: "Retry in a moment.", retryable: true }],
  }, "varity_redeploy", { name: "api-1" });
  assert.equal(out.error.suggestion, "Retry in a moment.");
});

test("an unpriced template reads 'price unavailable' in list, info and deploy", async () => {
  const template = { id: "adminer", name: "Adminer", private: false, requiredEnv: [] };
  const list = await call({ "/api/templates": [200, { templates: [template], count: 1 }] }, "varity_list_templates");
  assert.match(list.out.message, /, price unavailable\./);
  const info = await call({ "/api/templates/adminer": [200, { template }] }, "varity_template_info", { template: "adminer" });
  assert.match(info.out.message, /Pricing: price unavailable/);
  const deployed = await call({
    "/api/templates/adminer": [200, { template }],
    "/api/templates/adminer/deploy": [202, { id: "d-1", run_id: "run-1" }],
    "/api/deployments/runs/run-1": [200, { public_status: "deploying" }],
  }, "varity_deploy_template", { template: "adminer" });
  assert.match(deployed.out.message, /price unavailable/);
  assert.doesNotMatch(deployed.out.message, /price price/);
});

test("delete warns the URL may serve cached content briefly", async () => {
  // Live: status deleted and billing stopped while the URL still served 200 for up to ~40 s (E1 journey 3 step 9).
  const accepted = await call({
    "/api/deployments/app-1": [202, { status: "deleting", run_id: "run-1" }],
    "/api/deployments/runs/run-1": [200, { public_status: "deleting" }],
  }, "varity_delete_deployment", { deployment: "app-1" });
  assert.match(accepted.out.message, /URL may serve cached content briefly/);
  const deleted = await call({ "/api/deployments/app-2": [200, { deleted: true }] }, "varity_delete_deployment", { deployment: "app-2" });
  assert.match(deleted.out.message, /URL may serve cached content briefly/);
});

// ── 8. Journey 2.3.26 fix rows (evidence phase3/journey-2.3.26) ─────────────

test("J-3: the no-key, wrong-key and not-authenticated remedies are one text naming where to create a key", async () => {
  const { execFileSync } = await import("node:child_process");
  // An empty HOME and no key env: the no-key paths as a fresh user meets them.
  const script = `
    const { verifyAuthentication } = await import(${JSON.stringify(new URL("../dist/tools/doctor.js", import.meta.url).href)});
    const api = await import(${JSON.stringify(new URL("../dist/utils/public-api.js", import.meta.url).href)});
    const noKey = (await verifyAuthentication(null)).fix;
    let notAuthenticated;
    try { await api.publicApiGet("/api/deployments"); } catch (err) { notAuthenticated = err.action; }
    process.stdout.write(JSON.stringify({ noKey, notAuthenticated }));`;
  const fresh = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "varity-nokey-")), VARITY_GATEWAY_URL: "https://gw.test" },
  }).toString());
  const wrongKey = (await call({
    "/api/deployments": [401, { code: "invalid_api_key", message: "The API key is invalid or revoked." }],
  }, "varity_deploy_status")).out.error.suggestion;
  assert.match(fresh.noKey, /https:\/\/developer\.store\.varity\.so\/dashboard\/settings\?tab=api-keys/);
  assert.equal(fresh.noKey, wrongKey);
  assert.equal(fresh.notAuthenticated, wrongKey);
});

/** The gateway's served `profile_unknown` menu at 2.3.26 (journey J-1): it still lists ai-agent-gpu. */
const SERVED_PROFILE_MENU = ["static-site", "web-app", "web-app-db", "ai-agent-cpu", "ai-agent-gpu"];

test("J-1: cost_calculator never offers a profile it refuses", async () => {
  const unknown = await call({
    "/api/pricing": [400, { code: "profile_unknown", error: "Unknown pricing profile", profiles: SERVED_PROFILE_MENU }],
  }, "varity_cost_calculator", { app_profile: "nope" });
  assert.equal(unknown.out.error.code, "profile_unknown");
  assert.match(unknown.out.error.suggestion, /static-site, web-app, web-app-db, ai-agent-cpu\.$/);
  assert.doesNotMatch(unknown.out.error.suggestion, /ai-agent-gpu/);
});

const STATIC_ESTIMATE = {
  profile: "static-site", currency: "USD", monthly_max_usd: 0, billing_model: "free_static",
  billing_note: "First 3 static sites free, then $1/month per site", mode: "static",
};

test("J-4: the estimate carries the configured deploy key so the owner can price the caller's real count", async () => {
  const { calls } = await call({ "/api/pricing": [200, STATIC_ESTIMATE] }, "varity_cost_calculator", { app_profile: "static-site" });
  assert.equal(calls[0].url, "https://gw.test/api/pricing?profile=static-site");
  assert.equal(calls[0].init.headers.Authorization, "Bearer api-key");

  const saved = process.env["VARITY_DEPLOY_KEY"];
  delete process.env["VARITY_DEPLOY_KEY"];
  try {
    const anonymous = await call({ "/api/pricing": [200, STATIC_ESTIMATE] }, "varity_cost_calculator", { app_profile: "static-site" });
    assert.equal(anonymous.out.success, true);
    assert.equal(anonymous.calls[0].init.headers.Authorization, undefined, "without a key the estimate stays anonymous");
  } finally {
    process.env["VARITY_DEPLOY_KEY"] = saved;
  }
});

test("J-4: a rejected key on the estimate gets the deploy-key remedy, never an anonymous fallback quote", async () => {
  const { out, calls } = await call({
    "/api/pricing": [401, { code: "invalid_api_key", message: "The API key is invalid or revoked." }],
  }, "varity_cost_calculator", { app_profile: "static-site" });
  assert.equal(out.success, false);
  assert.equal(out.error.code, "invalid_api_key");
  assert.match(out.error.suggestion, /deploy key at https:\/\/developer\.store\.varity\.so\/dashboard\/settings\?tab=api-keys/);
  assert.equal(calls.length, 1, "no second, anonymous request");
  assert.equal(calls[0].init.headers.Authorization, "Bearer api-key");
});

test("J-4: the estimate summary states the served billing_note verbatim", async () => {
  const { out } = await call({ "/api/pricing": [200, STATIC_ESTIMATE] }, "varity_cost_calculator", { app_profile: "static-site" });
  assert.ok(out.message.includes(STATIC_ESTIMATE.billing_note), out.message);
});

/** The served uptime-kuma template at 2.3.26 (journey tplinfo). */
const UPTIME_KUMA = {
  id: "uptime-kuma", name: "Uptime Kuma", description: "Private uptime monitoring.", category: "monitoring",
  required_env: [], requiredEnv: [], hardware: { cpu: 1, memory_gb: 2, ephemeral_gb: 5 },
  volume: { sizeGb: 2, path: "/app/data" }, private: false, resources: [], certification: { state: "certified" },
};

test("J-6: template_info's hardware line includes the persistent volume", async () => {
  const { out } = await call({ "/api/templates/uptime-kuma": [200, { template: UPTIME_KUMA }] }, "varity_template_info", { template: "uptime-kuma" });
  assert.match(out.message, /Hardware: 1 CPU, 2 GiB RAM, 5 GiB ephemeral storage, 2 GiB persistent volume/);
});

test("J-6: deploy_template states the deployment id exactly as varity_deploy does", async () => {
  const id = "88d8e064-c086-4757-be4c-7a108a4ea26b";
  const run = "c03844ee-29dd-48f6-8891-602373984724";
  const template = await call({
    "/api/templates/uptime-kuma": [200, { template: UPTIME_KUMA }],
    "/api/templates/uptime-kuma/deploy": [202, { id, app_name: "j2326-kuma", run_id: run }],
    [`/api/deployments/runs/${run}`]: [200, { public_status: "deploying" }],
  }, "varity_deploy_template", { template: "uptime-kuma", name: "j2326-kuma" });
  const deploy = await call({
    "/api/deployments": [202, { id, app_name: "j2326-kuma", run_id: run }],
    [`/api/deployments/runs/${run}`]: [200, { public_status: "deploying" }],
  }, "varity_deploy", { image: "ghcr.io/you/app:latest", app_name: "j2326-kuma" });
  const tracked = `(id ${id}, run ${run}, status deploying). Track its terminal outcome with varity_deploy_status using this id; status returns the same id.`;
  assert.ok(deploy.out.message.includes(tracked), deploy.out.message);
  assert.ok(template.out.message.includes(tracked), template.out.message);
});

test("J-7: status reports a failed latest run, its failure and action code, not only 'live at'", async () => {
  // The real failed restart of a live template app (journey post-restart-status).
  const id = "88d8e064-c086-4757-be4c-7a108a4ea26b";
  const run = "8d3a1845-b29a-4f82-a468-209d3b72be8f";
  const outcome = {
    classification: "expected_rejection", stage: "allocation", code: "configuration_rejected",
    action_code: "check_configuration", diagnostic_code: "in_place_resources_changed",
    terminal_at: "2026-11-17T20:24:49.905517+00:00",
  };
  const { out } = await call({
    [`/api/deployments/${id}`]: [200, { deployment: {
      id, operation_deployment_id: id, app_name: "j2326-kuma-2021", runtime: "dynamic", status: "live",
      url: "https://j2326-kuma-2021.varity.app", created_at: "2026-11-17T20:24:32.010Z", run_id: run, outcome,
    } }],
    [`/api/deployments/runs/${run}`]: [200, { public_status: "failed", outcome }],
  }, "varity_deploy_status", { deployment_id: id });
  assert.equal(out.data.deployment.run_status, "failed");
  assert.match(out.message, /latest run failed/i);
  assert.match(out.message, /configuration_rejected/);
  assert.match(out.message, /in_place_resources_changed/);
  assert.match(out.message, /check_configuration/);
  assert.doesNotMatch(out.message, /^Deployment [^:]+: live at/);

  const healthy = await call({
    [`/api/deployments/${id}`]: [200, { deployment: { id, status: "live", url: "https://a.varity.app", run_id: run, outcome: { classification: "succeeded", code: "deployment_succeeded" } } }],
    [`/api/deployments/runs/${run}`]: [200, { public_status: "live" }],
  }, "varity_deploy_status", { deployment_id: id });
  assert.equal(healthy.out.message, `Deployment ${id}: live at https://a.varity.app`);
});

test("J-7: a failed run is reported from either signal, and a cancelled run is not called failed", async () => {
  const id = "op-7";
  const run = "run-7";
  const failedOutcome = { classification: "expected_rejection", code: "configuration_rejected", action_code: "check_configuration" };
  const status = (row, runView) => call({
    [`/api/deployments/${id}`]: [200, { deployment: { id, status: "live", url: "https://a.varity.app", run_id: run, ...row } }],
    [`/api/deployments/runs/${run}`]: runView,
  }, "varity_deploy_status", { deployment_id: id });

  // The run view is unreadable: the row's sealed classification alone says it failed.
  const unread = await status({ outcome: failedOutcome }, [502, { code: "deploy_status_unavailable" }]);
  assert.equal(unread.out.data.deployment.run_status, null);
  assert.match(unread.out.message, /latest run failed \(expected_rejection, configuration_rejected; action check_configuration\)/);

  // The row carries no outcome: the run view's outcome names the failure.
  const fromRun = await status({}, [200, { public_status: "failed", outcome: failedOutcome }]);
  assert.match(fromRun.out.message, /latest run failed \(expected_rejection, configuration_rejected; action check_configuration\)/);

  const cancelled = await status({ outcome: { classification: "cancelled", code: "deployment_cancelled" } }, [200, { public_status: "live" }]);
  assert.match(cancelled.out.message, /latest run was cancelled \(cancelled, deployment_cancelled\)/);
  assert.doesNotMatch(cancelled.out.message, /failed/);
});

test("J-7: a deployment that itself failed says so, and the list names a failed most recent run", async () => {
  const outcome = { classification: "user_workload_failure", code: "health_check_failed", action_code: "check_logs" };
  const failed = await call({
    "/api/deployments/op-f": [200, { deployment: { id: "op-f", status: "failed", run_id: "run-f", outcome } }],
    "/api/deployments/runs/run-f": [200, { public_status: "failed", outcome }],
  }, "varity_deploy_status", { deployment_id: "op-f" });
  assert.equal(failed.out.message, "Deployment op-f: latest run failed (user_workload_failure, health_check_failed; action check_logs). Deployment status: failed (URL not assigned yet)");

  const list = await call({
    "/api/deployments": [200, { deployments: [{ id: "op-f", app_name: "app-f", status: "live", url: "https://app-f.varity.app", created_at: "2026-11-17T20:00:00Z", run_id: "run-f", outcome }] }],
  }, "varity_deploy_status");
  assert.match(list.out.message, /Most recent: app-f \(https:\/\/app-f\.varity\.app\), latest run failed \(user_workload_failure, health_check_failed; action check_logs\)$/);
});

// ── 9. Journey 2.3.27 re-run rows ───────────────────────────────────────────

test("J-10: the billing_note joins the summary as a full sentence, whatever punctuation is served", async () => {
  const estimate = (billing_note) => call({
    "/api/pricing": [200, { ...STATIC_ESTIMATE, billing_note }],
  }, "varity_cost_calculator", { app_profile: "static-site" });
  const bare = await estimate("First 3 static sites free, then $1/month per site");
  assert.match(bare.out.message, / First 3 static sites free, then \$1\/month per site\.$/);
  const stopped = await estimate("First 3 static sites are free, then $1/month per site.");
  assert.match(stopped.out.message, / then \$1\/month per site\.$/);
  assert.doesNotMatch(stopped.out.message, /\.\.$/);
  const padded = await estimate("  Billed $1/month!  ");
  assert.match(padded.out.message, /interface\. Billed \$1\/month!$/);
});

test("J-11: a deleted deployment never points at its retired URL", async () => {
  const id = "op-del";
  const row = { id, operation_deployment_id: id, app_name: "gone-app", status: "deleted", url: "https://gone-app.varity.app", created_at: "2026-11-17T20:00:00Z", run_id: "run-del", outcome: { classification: "succeeded", code: "deployment_deleted" } };
  const single = await call({
    [`/api/deployments/${id}`]: [200, { deployment: row }],
    "/api/deployments/runs/run-del": [200, { public_status: "deleted" }],
  }, "varity_deploy_status", { deployment_id: id });
  assert.equal(single.out.message, `Deployment ${id}: deleted`);
  const list = await call({ "/api/deployments": [200, { deployments: [row] }] }, "varity_deploy_status");
  assert.match(list.out.message, /Most recent: gone-app \(deleted\)$/);
  assert.doesNotMatch(`${single.out.message} ${list.out.message}`, /gone-app\.varity\.app/);
});
