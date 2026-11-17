/**
 * Creates are idempotent end to end. Templates go through the public API
 * (`GET /api/templates[/:id]`, `POST /api/templates/:id/deploy`) with no
 * varitykit child process; template deploy, deploy and redeploy each send a
 * per-call Idempotency-Key, and a 504 `deploy_acceptance_unconfirmed` is
 * followed by exactly one resend with the same key (gateway #857: an unkeyed
 * retry is a second deployment). Keys are never derived from content
 * (REGRESSIONS-LEDGER R839).
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const RUN_ID = "19c9f0b2-5ffa-4391-a096-dd964787f929";
const TEMPLATE = { id: "demo", name: "Demo", private: false, required_env: [], requiredEnv: [], certification: { state: "certified" } };
const UNCONFIRMED = [504, {
  code: "deploy_acceptance_unconfirmed",
  message: "Varity could not confirm whether this deployment was accepted. It may already be starting.",
  retryable: true,
}];
const ACCEPTED = [202, { id: "d-1", app_name: "demo", status: "deploying", run_id: RUN_ID }];

/** A PATH whose varitykit and python only leave a marker, so any spawn is observable. */
function spawnTrap() {
  const bin = mkdtempSync(join(tmpdir(), "mcp-spawn-trap-"));
  const marker = join(bin, "spawned");
  for (const name of ["varitykit", "python", "python3"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> ${marker}\necho '{"templates":[]}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, marker };
}

/** Routes `METHOD path` to a queue of responses (the last one repeats); records every call. */
function stubGateway(routes) {
  const calls = [];
  const original = globalThis.fetch;
  const used = {};
  globalThis.fetch = async (url, init) => {
    const route = `${init.method} ${new URL(url).pathname}`;
    calls.push({ route, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const queue = routes[route] ?? [[404, { code: "not_found" }]];
    const index = Math.min(used[route] ?? 0, queue.length - 1);
    used[route] = (used[route] ?? 0) + 1;
    const [status, body] = queue[index];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function callTool(routes, name, args) {
  const trap = spawnTrap();
  const savedPath = process.env.PATH;
  process.env.PATH = trap.bin;
  const stub = stubGateway(routes);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "idempotency-test", version: "1" });
  await client.connect(clientSide);
  try {
    const result = await client.callTool({ name, arguments: args });
    return { out: JSON.parse(result.content[0].text), calls: stub.calls, spawned: existsSync(trap.marker) };
  } finally {
    await client.close();
    stub.restore();
    process.env.PATH = savedPath;
    rmSync(trap.bin, { recursive: true, force: true });
  }
}

const posts = (calls, route) => calls.filter((call) => call.route === route);
const RUN_ROUTE = `GET /api/deployments/runs/${RUN_ID}`;

test("template list and detail read the public API without a child process", async () => {
  for (const [tool, args] of [["varity_list_templates", {}], ["varity_list_agents", {}]]) {
    const { out, calls, spawned } = await callTool({ "GET /api/templates": [[200, { templates: [TEMPLATE], count: 1 }]] }, tool, args);
    assert.equal(spawned, false, tool);
    assert.equal(out.success, true, tool);
    assert.equal(out.data.count, 1, tool);
    assert.deepEqual(calls.map((call) => call.route), ["GET /api/templates"], tool);
  }
  const { out, spawned } = await callTool({ "GET /api/templates/demo": [[200, { template: TEMPLATE }]] }, "varity_template_info", { template: "demo" });
  assert.equal(spawned, false);
  assert.equal(out.success, true);
  assert.match(out.message, /Pricing: unavailable/);
});

test("template info shows the catalog price when served", async () => {
  const priced = { ...TEMPLATE, pricing: { monthlyUsd: 12 } };
  const { out } = await callTool({ "GET /api/templates/demo": [[200, { template: priced }]] }, "varity_template_info", { template: "demo" });
  assert.match(out.message, /\$12/);
});

for (const tool of ["varity_deploy_template", "varity_deploy_agent"]) {
  test(`${tool}: source mcp, an Idempotency-Key, and one resend with the same key after 504`, async () => {
    const arg = tool === "varity_deploy_template" ? { template: "demo", name: "my-demo" } : { agent: "demo", name: "my-demo" };
    const { out, calls, spawned } = await callTool({
      "GET /api/templates/demo": [[200, { template: TEMPLATE }]],
      "POST /api/templates/demo/deploy": [UNCONFIRMED, ACCEPTED],
      [RUN_ROUTE]: [[200, { public_status: "deploying", outcome: null }]],
    }, tool, arg);
    assert.equal(spawned, false);
    const sent = posts(calls, "POST /api/templates/demo/deploy");
    assert.equal(sent.length, 2);
    const key = sent[0].init.headers["Idempotency-Key"];
    assert.match(key, /^[A-Za-z0-9._:-]{8,160}$/);
    assert.equal(sent[1].init.headers["Idempotency-Key"], key);
    for (const call of sent) assert.deepEqual(call.body, { name: "my-demo", source: "mcp" });
    assert.equal(out.success, true);
    assert.equal(out.data.run_id, RUN_ID);
  });
}

test("a second 504 is not resent again", async () => {
  const { out, calls } = await callTool({
    "GET /api/templates/demo": [[200, { template: TEMPLATE }]],
    "POST /api/templates/demo/deploy": [UNCONFIRMED],
  }, "varity_deploy_template", { template: "demo" });
  assert.equal(posts(calls, "POST /api/templates/demo/deploy").length, 2);
  assert.equal(out.success, false);
  assert.equal(out.error.code, "deploy_acceptance_unconfirmed");
});

test("each call gets its own key, never one derived from the request", async () => {
  const routes = {
    "GET /api/templates/demo": [[200, { template: TEMPLATE }]],
    "POST /api/templates/demo/deploy": [ACCEPTED],
    [RUN_ROUTE]: [[200, { public_status: "deploying" }]],
  };
  const first = await callTool(routes, "varity_deploy_template", { template: "demo" });
  const second = await callTool(routes, "varity_deploy_template", { template: "demo" });
  const key = (run) => posts(run.calls, "POST /api/templates/demo/deploy")[0].init.headers["Idempotency-Key"];
  assert.notEqual(key(first), key(second));
});

test("private and secret-bearing templates are refused before any deploy request", async () => {
  for (const template of [
    { ...TEMPLATE, private: true },
    { ...TEMPLATE, required_env: ["API_KEY"], requiredEnv: undefined },
  ]) {
    const { out, calls } = await callTool({ "GET /api/templates/demo": [[200, { template }]] }, "varity_deploy_template", { template: "demo" });
    assert.equal(out.error.code, "SECURE_ENV_CONFIGURATION_REQUIRED");
    assert.deepEqual(calls.map((call) => call.route), ["GET /api/templates/demo"]);
  }
});

test("varity_deploy: an Idempotency-Key and one resend with the same key after 504", async () => {
  const { out, calls } = await callTool({
    "POST /api/deployments": [UNCONFIRMED, ACCEPTED],
    [RUN_ROUTE]: [[200, { public_status: "deploying" }]],
  }, "varity_deploy", { repo_url: "https://github.com/me/app" });
  const sent = posts(calls, "POST /api/deployments");
  assert.equal(sent.length, 2);
  const key = sent[0].init.headers["Idempotency-Key"];
  assert.match(key, /^[A-Za-z0-9._:-]{8,160}$/);
  assert.equal(sent[1].init.headers["Idempotency-Key"], key);
  assert.equal(sent[0].body.source, "mcp");
  assert.deepEqual(sent[0].body, sent[1].body);
  assert.equal(out.success, true);
});

test("varity_redeploy: an Idempotency-Key and one resend with the same key after 504", async () => {
  const { out, calls } = await callTool({
    "POST /api/deployments/my-api/redeploy": [UNCONFIRMED, ACCEPTED],
    [RUN_ROUTE]: [[200, { public_status: "deploying" }]],
  }, "varity_redeploy", { name: "my-api" });
  const sent = posts(calls, "POST /api/deployments/my-api/redeploy");
  assert.equal(sent.length, 2);
  const key = sent[0].init.headers["Idempotency-Key"];
  assert.match(key, /^[A-Za-z0-9._:-]{8,160}$/);
  assert.equal(sent[1].init.headers["Idempotency-Key"], key);
  assert.equal(out.success, true);
});

test("any other failure is not resent", async () => {
  const { calls } = await callTool({ "POST /api/deployments": [[502, { code: "bad_gateway" }]] }, "varity_deploy", { repo_url: "https://github.com/me/app" });
  assert.equal(posts(calls, "POST /api/deployments").length, 1);
});
