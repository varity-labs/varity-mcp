/**
 * The one public-API client (src/utils/public-api.ts) must send every Cloud
 * call with the MCP's key, `source: "mcp"` on create, and the exact route,
 * method, body and idempotency header the gateway contract requires
 * (gateway-v1.14.88 routes/public-api.ts, services/machine-public.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

process.env["VARITY_GATEWAY_URL"] = "https://gw.test";
process.env["VARITY_API_KEY"] = "api-key";
process.env["VARITY_DEPLOY_KEY"] = "deploy-key";

const api = await import("../dist/utils/public-api.js");

function stubFetch(status, payload) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function oneCall(status, payload, run) {
  const stub = stubFetch(status, payload);
  try {
    const result = await run();
    assert.equal(stub.calls.length, 1);
    const { url, init } = stub.calls[0];
    return { result, url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) };
  } finally {
    stub.restore();
  }
}

test("every call carries VARITY_API_KEY first", async () => {
  const { init } = await oneCall(200, { deployments: [] }, () => api.listDeployments());
  assert.equal(init.headers.Authorization, "Bearer api-key");
});

test("createDeployment posts the body with source mcp and only a caller's idempotency key", async () => {
  const { result, url, init, body } = await oneCall(202, { run_id: "r-1" }, () =>
    api.createDeployment({ repo_url: "https://github.com/a/b", source: "cli" })
  );
  assert.equal(url, "https://gw.test/api/deployments");
  assert.equal(init.method, "POST");
  assert.deepEqual(body, { repo_url: "https://github.com/a/b", source: "mcp" });
  assert.equal(init.headers["Idempotency-Key"], undefined);
  assert.equal(result.run_id, "r-1");
  const keyed = await oneCall(202, { run_id: "r-2" }, () => api.createDeployment({}, "k-1"));
  assert.equal(keyed.init.headers["Idempotency-Key"], "k-1");
});

test("deployment lifecycle routes and bodies match the gateway", async () => {
  const del = await oneCall(202, { status: "deleting", run_id: "r" }, () => api.deleteDeployment("my app"));
  assert.equal(del.url, "https://gw.test/api/deployments/my%20app");
  assert.equal(del.init.method, "DELETE");
  assert.equal(del.body, undefined);

  const re = await oneCall(202, { run_id: "r" }, () => api.redeploy("d-1"));
  assert.equal(re.url, "https://gw.test/api/deployments/d-1/redeploy");
  assert.equal(re.init.method, "POST");

  const run = await oneCall(200, { public_status: "failed", outcome: { stage: "build" } }, () => api.getRun("r-1"));
  assert.equal(run.url, "https://gw.test/api/deployments/runs/r-1");
  assert.equal(run.init.method, "GET");
  assert.equal(run.result.public_status, "failed");
});

test("machine routes send the required idempotency key", async () => {
  const list = await oneCall(200, { machines: [{ id: "m-1" }] }, () => api.listMachines());
  assert.equal(list.url, "https://gw.test/api/machines");
  assert.deepEqual(list.result.machines, [{ id: "m-1" }]);

  const request = { name: "vm", profile_id: "p", execution_class: "cpu_virtual_machine", os_image: "ubuntu", ssh_public_key: "ssh-ed25519 AAAA", accelerator_quote_token: "t".repeat(16) };
  const create = await oneCall(202, { run_id: "r" }, () => api.createMachine(request));
  assert.equal(create.url, "https://gw.test/api/machines");
  assert.equal(create.init.method, "POST");
  assert.deepEqual(create.body, request);
  assert.match(create.init.headers["Idempotency-Key"], /^mcp-machine-create:/);

  const del = await oneCall(202, { run_id: "r", machine_id: "m-1" }, () => api.deleteMachine("m-1"));
  assert.equal(del.url, "https://gw.test/api/machines/m-1");
  assert.equal(del.init.method, "DELETE");
  assert.match(del.init.headers["Idempotency-Key"], /^mcp-machine-delete:/);
});

test("a gateway error keeps its code, status and action", async () => {
  await assert.rejects(
    oneCall(404, { code: "not_found", message: "Machine not found.", action: "Check the machine identifier." }, () => api.deleteMachine("x")),
    (err) => err.code === "not_found" && err.status === 404 && err.action === "Check the machine identifier."
  );
});

test("an unreachable gateway is reported as unreachable, never as success", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    await assert.rejects(api.redeploy("d-1"), (err) => err.code === "VARITY_API_UNREACHABLE");
  } finally {
    globalThis.fetch = original;
  }
});
