/**
 * 2.3.28 journey grade-1 polish (coordinator list after the J-19..J-21
 * blockers): value line in the README, doctor "Not connected yet" with a
 * `connected` field, "Building now." on accept, the monthly cost on a live
 * status, static-site logs as a normal answer and `deployment_id` on logs,
 * plain domain copy, the cached-content line only for an app that had a URL,
 * "Billing has stopped." after delete, and the balance hold wording.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "api-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-polish-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const RUN = "19c9f0b2-5ffa-4391-a096-dd964787f929";

async function call(name, args, routes) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "polish", version: "1" });
  await client.connect(clientSide);
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    const [status, body] = routes[`${init.method} ${path}`] ?? routes[path] ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    const result = await client.callTool({ name, arguments: args });
    return { out: JSON.parse(result.content[0].text), isError: result.isError === true, calls };
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

test("1: the README states the value in one plain line, canon-clean", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const line = readme.split("\n").find((l) => l.startsWith("Ask your AI to put your app online"));
  assert.ok(line, "value line present near the top");
  assert.match(line, /you can see the cost before anything deploys/);
  assert.match(line, /live in seconds/);
  assert.match(line, /never in the chat/);
  assert.doesNotMatch(line, /[–—]|blockchain|decentraliz|DePIN|cheapest|revolution/i);
});

test("2: doctor with no key leads with 'Not connected yet' and says connected: false; ready keeps its meaning", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "varity-doctor-"));
  const script = `
    const { registerDoctorTool } = await import(${JSON.stringify(new URL("../dist/tools/doctor.js", import.meta.url).href)});
    let handler; registerDoctorTool({ registerTool: (_n, _c, fn) => { handler = fn; } });
    process.stdout.write((await handler({})).content[0].text);`;
  const text = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: home, CI: "true", VARITY_GATEWAY_URL: "http://127.0.0.1:9" },
  }).toString();
  const out = JSON.parse(text);
  assert.match(out.message, /^Not connected yet: call varity_login/);
  assert.equal(out.data.connected, false);
  assert.equal(out.data.cli_deploy_ready, false, "not deploy-ready without a key");
  assert.equal(typeof out.data.ready, "boolean", "ready is unchanged: it still means local development readiness");
});

test("3: an accepted deploy says it is building and usually live in under a minute", async () => {
  const { out } = await call("varity_deploy", { repo_url: "https://github.com/acme/site" }, {
    "POST /api/deployments": [202, { id: "d-1", app_name: "site", status: "deploying", run_id: RUN }],
  });
  assert.match(out.message, /^Building now; usually live in under a minute\. Deploy accepted/);
});

test("4: a live status names the monthly cost when the data has it, and nothing when it does not", async () => {
  const row = { id: "op-l", status: "live", url: "https://shop.varity.app", run_id: "run-l" };
  const priced = await call("varity_deploy_status", { deployment_id: "op-l" }, {
    "/api/deployments/op-l": [200, { deployment: { ...row, billing: { state: "active", fixed_monthly_cost_usd: "1.00" } } }],
    "/api/deployments/runs/run-l": [200, { public_status: "live" }],
  });
  assert.match(priced.out.message, /It costs \$1\.00\/month\.$/);
  const big = await call("varity_deploy_status", { deployment_id: "op-l" }, {
    "/api/deployments/op-l": [200, { deployment: { ...row, billing: { state: "active", fixed_monthly_cost_usd: "1234.5" } } }],
    "/api/deployments/runs/run-l": [200, { public_status: "live" }],
  });
  assert.match(big.out.message, /It costs \$1,234\.50\/month\.$/, "shared usd() grouping");
  const unpriced = await call("varity_deploy_status", { deployment_id: "op-l" }, {
    "/api/deployments/op-l": [200, { deployment: row }],
    "/api/deployments/runs/run-l": [200, { public_status: "live" }],
  });
  assert.doesNotMatch(unpriced.out.message, /month/);
});

test("5: a static site's 'no runtime logs' is a normal answer, and deployment_id works", async () => {
  const routes = {
    "/api/deployments/site/logs": [409, {
      code: "runtime_not_started", retryable: false,
      message: "This is a static site: it is served as files and has no runtime, so there are no runtime logs.",
    }],
  };
  const byName = await call("varity_deploy_logs", { deployment: "site" }, routes);
  assert.equal(byName.isError, false);
  assert.equal(byName.out.success, true);
  assert.match(byName.out.message, /is a static site: it is served as files and has no server, so it has no runtime logs\. That is normal\./);
  const byId = await call("varity_deploy_logs", { deployment_id: "site" }, routes);
  assert.equal(byId.out.success, true);
  assert.ok(byId.calls.includes("GET /api/deployments/site/logs"));
});

test("7: the cached-content line appears only when the deployment ever had a URL", async () => {
  const deleted = [200, { deleted: true }];
  const withUrl = await call("varity_delete_deployment", { deployment: "shop" }, {
    "GET /api/deployments/shop": [200, { deployment: { id: "shop", status: "live", url: "https://shop.varity.app" } }],
    "DELETE /api/deployments/shop": deleted,
  });
  assert.match(withUrl.out.message, /cached content/);
  const never = await call("varity_delete_deployment", { deployment: "shop" }, {
    "GET /api/deployments/shop": [200, { deployment: { id: "shop", status: "failed", url: null } }],
    "DELETE /api/deployments/shop": deleted,
  });
  assert.doesNotMatch(never.out.message, /cached content/);
});

test("8: status after delete says 'Billing has stopped.' when billing.state is stopped", async () => {
  const stopped = await call("varity_deploy_status", { deployment_id: "op-d" }, {
    "/api/deployments/op-d": [200, { deployment: { id: "op-d", status: "deleted", run_id: "run-d", billing: { state: "stopped" } } }],
    "/api/deployments/runs/run-d": [200, { public_status: "deleted" }],
  });
  assert.match(stopped.out.message, /Billing has stopped\.$/);
  const pending = await call("varity_deploy_status", { deployment_id: "op-d" }, {
    "/api/deployments/op-d": [200, { deployment: { id: "op-d", status: "deleted", run_id: "run-d", billing: { state: "active" } } }],
    "/api/deployments/runs/run-d": [200, { public_status: "deleted" }],
  });
  assert.doesNotMatch(pending.out.message, /Billing has stopped/);
});
