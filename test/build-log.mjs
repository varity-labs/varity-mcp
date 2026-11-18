/**
 * P9-BUILDLOG (plan rev 9, V9-5): `varity_deploy_status` on a failed run reads
 * `GET /api/deployments/runs/{run_id}/logs` (gateway `buildLogBody`: lines,
 * count, complete, stage, observed_at), returns only the last lines, and
 * redacts them again locally (`redactPublicText` + secret patterns + the
 * configured deploy key as a known value).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const KNOWN_KEY = "k3y-known-deploy-value-0001";
process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = KNOWN_KEY;
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-buildlog-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");
const { redactPublicText } = await import("../dist/utils/redact.js");

async function status(routes, args) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "buildlog", version: "1" });
  await client.connect(clientSide);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const [code, body] = routes[path] ?? [404, { code: "not_found" }];
    return { ok: code >= 200 && code < 300, status: code, json: async () => body };
  };
  try {
    const result = await client.callTool({ name: "varity_deploy_status", arguments: args });
    return { out: JSON.parse(result.content[0].text), calls };
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

const FAILED_ROW = {
  id: "op-f", operation_deployment_id: "op-f", app_name: "shop", status: "failed", run_id: "run-f",
  outcome: { classification: "user_workload_failure", code: "build_failed", stage: "build" },
};

test("a failed run returns the last build error lines, redacted, and says how to fix it", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `step ${i}`);
  lines.push("error: token=vk_live_abcdef0123456789 leaked");
  lines.push(`Authorization header was ${KNOWN_KEY}`);
  lines.push("src/app.ts(3,1): error TS2304: Cannot find name 'foo'.");
  const { out, calls } = await status({
    "/api/deployments/op-f": [200, { deployment: FAILED_ROW }],
    "/api/deployments/runs/run-f": [200, { public_status: "failed", outcome: FAILED_ROW.outcome }],
    "/api/deployments/runs/run-f/logs": [200, { lines, count: lines.length, complete: true, source: "build", stage: "build", observed_at: null }],
  }, { deployment_id: "op-f" });
  assert.ok(calls.includes("/api/deployments/runs/run-f/logs"), "the run's build log is read");
  const build = out.data.build_error;
  assert.equal(build.lines.length, 20, "only the last 20 lines");
  assert.equal(build.lines.at(-1), "src/app.ts(3,1): error TS2304: Cannot find name 'foo'.", "ordinary compiler text is kept");
  assert.equal(build.stage, "build");
  assert.equal(build.complete, false, "a cut window is not complete");
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /vk_live_abcdef/);
  assert.ok(!text.includes(KNOWN_KEY), "the configured deploy key never appears");
  assert.match(out.message, /build_error\.lines/);
  assert.match(out.message, /deploy again with varity_deploy/);
  assert.doesNotMatch(out.message, /build locally/i);
});

test("a failed run with no recorded build error invents no lines", async () => {
  const { out } = await status({
    "/api/deployments/op-f": [200, { deployment: FAILED_ROW }],
    "/api/deployments/runs/run-f": [200, { public_status: "failed", outcome: FAILED_ROW.outcome }],
    "/api/deployments/runs/run-f/logs": [404, { code: "build_log_not_found" }],
  }, { deployment_id: "op-f" });
  assert.equal(out.success, true);
  assert.equal("build_error" in out.data, false);
  assert.match(out.message, /latest run failed/);
});

test("a live deployment never reads the build log", async () => {
  const { calls } = await status({
    "/api/deployments/op-l": [200, { deployment: { id: "op-l", status: "live", run_id: "run-l", url: "https://shop.varity.app" } }],
    "/api/deployments/runs/run-l": [200, { public_status: "live", outcome: { classification: "succeeded" } }],
  }, { deployment_id: "op-l" });
  assert.ok(!calls.some((path) => path.endsWith("/logs")));
});

test("redactPublicText removes secret shapes and known values but keeps words", () => {
  const out = redactPublicText(
    "vk_abc123XYZ ghp_0123456789abcdefABCDEF postgres://u:hunter2pw@db/x Bearer eyJabc.def password=s3cretvalue my-known-value plain token words Unexpected token: }",
    ["my-known-value"]
  );
  for (const secret of ["vk_abc123XYZ", "ghp_0123456789", "hunter2pw", "eyJabc.def", "s3cretvalue", "my-known-value"]) {
    assert.ok(!out.includes(secret), `${secret} redacted: ${out}`);
  }
  assert.match(out, /plain token words Unexpected token: \}/);
});

test("varity_deploy_logs no longer tells anyone to build locally", async () => {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "buildlog", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  const logs = tools.find((tool) => tool.name === "varity_deploy_logs");
  assert.doesNotMatch(logs.description, /local build|build locally|varity_build/i);
  assert.match(logs.description, /varity_deploy_status/);
});
