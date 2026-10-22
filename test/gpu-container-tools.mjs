/** Public MCP transport contract; catalog fixture is the Gateway producer output
 * db78e53e6f860e7132a8dc7cd08ae22cbcfa4d35, SHA256
 * 22adf1f86dcc885e54cce1958c95a97a645b5628ae9ad20ee0c19c879c9d8906.
 * Captured native offers are evidence of shape, never current availability. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_API_KEY = "fixture-key";
const { createVarityServer } = await import("../dist/server.js");

async function withClient(run) {
  const server = createVarityServer();
  const client = new Client({ name: "gpu-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(client); } finally { await client.close(); await server.close(); }
}

test("GPU container tools are discoverable with strict inputs through MCP transport", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    for (const name of ["varity_gpu_containers_profiles", "varity_gpu_containers_quote", "varity_gpu_containers_create"]) {
      const tool = tools.find((tool) => tool.name === name);
      assert.ok(tool, `${name} is discoverable`);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });
});

const payload = (response) => JSON.parse(response.content[0].text);
const DEPLOYMENT = "e218b910-5973-4931-bf27-cd382a7de528";
const ACCESS = { protocol: "ssh", host: "gpu.example.test", port: 30422, username: "root" };

async function withResponses(responses, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const next = responses[calls.length];
    calls.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    assert.ok(next, `Unexpected HTTP request ${url}`);
    const [status, data] = next;
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  };
  try { await withClient((client) => run(client, calls)); } finally { globalThis.fetch = original; }
}

test("GPU deployment status preserves served SSH access and execution class without an HTTP URL", async () => {
  await withResponses([[200, { deployment: { id: DEPLOYMENT, execution_class: "container", access: ACCESS,
    status: "live", billing: { state: "active", accrued_this_month_usd: null } } }]], async (client) => {
    const result = payload(await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: DEPLOYMENT } }));
    assert.deepEqual(result.data.deployment.access, ACCESS);
    assert.equal(result.data.deployment.execution_class, "container");
    assert.equal(result.data.deployment.billing.accrued_this_month_usd, null);
    assert.deepEqual(result.data.deployment.http_probe, { outcome: "not_applicable" });
    assert.equal(Object.hasOwn(result.data.deployment, "url"), false);
  });
});

const { readFile } = await import("node:fs/promises");
const { createHash } = await import("node:crypto");
const catalogBytes = await readFile(new URL("./fixtures/gpu-container-profiles-v2.json", import.meta.url));
assert.equal(createHash("sha256").update(catalogBytes).digest("hex"), "22adf1f86dcc885e54cce1958c95a97a645b5628ae9ad20ee0c19c879c9d8906");
const CATALOG = JSON.parse(catalogBytes);
const PROFILE = "gpo-0248e14b246513d0f8a2762f";
const QUOTE = {
  quote_token: "aq1.fixture-customer-approved-token", quote_reference: "quote-fixture-1",
  resource_fingerprint: "sha256:fixture-resource", hourly_usd: 1.431,
  authorization_usd: 5, valid_until: "2026-10-23T00:05:00Z",
};
const CREATE_INPUT = { name: "gpu-worker", profile_id: PROFILE, ssh_public_key: "ssh-ed25519 AAAA fixture@example.test",
  accelerator_quote_token: QUOTE.quote_token, idempotency_key: "gpu-retry-key-01" };

test("customer can use producer-generated v2 profiles, approve exact quote, and submit only five create keys", async () => {
  await withResponses([[200, CATALOG], [200, QUOTE], [202, { deployment_id: DEPLOYMENT, run_id: "create-run", status: "deploying" }]], async (client, calls) => {
    const catalog = payload(await client.callTool({ name: "varity_gpu_containers_profiles", arguments: {} }));
    assert.deepEqual(catalog.data, CATALOG);
    assert.equal(catalog.data.profiles.length, 10);
    assert.equal(catalog.data.profiles[0].availability.matching_capacity_count, null);
    assert.equal(catalog.data.profiles[0].availability.aggregate_available_units, null);
    assert.equal(catalog.data.profiles[0].resources.memory_mb, 15258);
    assert.equal(catalog.data.profiles[0].runtime.startup_command, null);
    assert.equal(catalog.data.profiles[0].customer_price.hourly_usd, 1.431);
    const quoted = payload(await client.callTool({ name: "varity_gpu_containers_quote", arguments: { profile_id: PROFILE } }));
    assert.deepEqual(quoted.data, QUOTE);
    assert.match(quoted.message, /Review.*customer/);
    const created = payload(await client.callTool({ name: "varity_gpu_containers_create", arguments: CREATE_INPUT }));
    assert.equal(created.data.deployment_id, DEPLOYMENT);
    assert.equal(created.data.status, "deploying");
    assert.match(created.message, /not proof it is live/);
    assert.equal(calls[0].url, "https://gw.test/api/deployment-profiles?workload=gpu&execution_class=container&contract_version=gpu-container-profiles-v2");
    assert.equal(calls[1].url, "https://gw.test/api/pricing/accelerator-quote");
    assert.deepEqual(calls[1].body, { execution_class: "container", profile_id: PROFILE });
    assert.equal(calls[2].url, "https://gw.test/api/deployments");
    assert.deepEqual(calls[2].body, { name: "gpu-worker", execution_class: "container", profile_id: PROFILE,
      ssh_public_key: CREATE_INPUT.ssh_public_key, accelerator_quote_token: QUOTE.quote_token });
    assert.equal(calls[2].init.headers["Idempotency-Key"], "gpu-retry-key-01");
    for (const call of calls) assert.equal(call.init.headers.Authorization, "Bearer fixture-key");
    assert.equal(calls.length, 3, "create consumes approved quote; it does not request another quote");
  });
});

test("create requires explicit quote and caller public key; private material and VM/image extras never reach HTTP", async () => {
  await withResponses([], async (client, calls) => {
    const invalid = [
      { ...CREATE_INPUT, ssh_public_key: undefined },
      { ...CREATE_INPUT, accelerator_quote_token: undefined },
      { ...CREATE_INPUT, ssh_public_key: "-----BEGIN OPENSSH PRIVATE KEY-----" },
      { ...CREATE_INPUT, ssh_public_key: "-----BEGIN RSA PRIVATE KEY-----" },
      { ...CREATE_INPUT, ssh_public_key: "ssh-ed25519 AAAA\nextra" },
      { ...CREATE_INPUT, image: "example/image:tag" },
      { ...CREATE_INPUT, source: "mcp" },
      { ...CREATE_INPUT, os_image: "ubuntu" },
      { ...CREATE_INPUT, execution_class: "virtual_machine" },
      { ...CREATE_INPUT, profile_id: "mp-0123456789abcdef01234567" },
      { ...CREATE_INPUT, idempotency_key: "bad" },
    ];
    for (const args of invalid) {
      const result = await client.callTool({ name: "varity_gpu_containers_create", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(Object.keys(args)));
    }
    assert.equal(calls.length, 0);
  });
});

test("create without a supplied retry key generates a contract-valid Idempotency-Key without changing its body", async () => {
  await withResponses([[202, { deployment_id: DEPLOYMENT }]], async (client, calls) => {
    const { idempotency_key, ...args } = CREATE_INPUT;
    const result = payload(await client.callTool({ name: "varity_gpu_containers_create", arguments: args }));
    assert.equal(result.success, true);
    assert.match(calls[0].init.headers["Idempotency-Key"], /^[A-Za-z0-9._:-]{8,128}$/);
    assert.equal(Object.keys(calls[0].body).length, 5);
  });
});

test("GPU quote/create and unavailable catalog preserve backend refusal codes instead of success or empty inventory", async () => {
  const cases = [
    ["varity_gpu_containers_profiles", {}, 503, "gpu_inventory_unavailable"],
    ["varity_gpu_containers_quote", { profile_id: PROFILE }, 409, "gpu_offer_no_longer_available"],
    ["varity_gpu_containers_create", CREATE_INPUT, 409, "accelerator_quote_expired"],
    ["varity_gpu_containers_create", CREATE_INPUT, 403, "accelerator_quote_owner_mismatch"],
    ["varity_gpu_containers_create", CREATE_INPUT, 429, "deployment_rate_limited"],
  ];
  for (const [name, args, status, code] of cases) {
    await withResponses([[status, { code, message: "Owner refused this request.", action: "Retry after refreshing the catalog." }]], async (client) => {
      const response = await client.callTool({ name, arguments: args });
      assert.equal(response.isError, true);
      const result = payload(response);
      assert.equal(result.success, false);
      assert.equal(result.error.code, code);
      assert.equal(result.error.message, "Owner refused this request.");
      assert.equal(result.error.suggestion, "Retry after refreshing the catalog.");
    });
  }
});

test("common delete acceptance leaves billing unconfirmed until status serves stopped; unread SSH remains null", async () => {
  await withResponses([
    [202, { run_id: "delete-run", status: "deleting" }],
    [200, { public_status: "deleting", outcome: null }],
    [200, { deployment: { id: DEPLOYMENT, execution_class: "container", status: "deleting", access: null,
      billing: { state: "active", accrued_this_month_usd: null } } }],
    [200, { deployment: { id: DEPLOYMENT, execution_class: "container", status: "deleted", access: null,
      billing: { state: "stopped", accrued_this_month_usd: 0.01 } } }],
  ], async (client, calls) => {
    const accepted = payload(await client.callTool({ name: "varity_delete_deployment", arguments: { deployment: DEPLOYMENT } }));
    assert.equal(accepted.data.deleted, false);
    assert.match(accepted.message, /billing stop is not proven/);
    const pending = payload(await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: DEPLOYMENT } }));
    assert.equal(pending.data.deployment.status, "deleting");
    assert.equal(pending.data.deployment.billing.state, "active");
    assert.equal(pending.data.deployment.access, null);
    const stopped = payload(await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: DEPLOYMENT } }));
    assert.equal(stopped.data.deployment.status, "deleted");
    assert.equal(stopped.data.deployment.billing.state, "stopped");
    assert.equal(stopped.data.deployment.access, null);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].url, `https://gw.test/api/deployments/${DEPLOYMENT}`);
  });
});

test("deployment collection and detail preserve the same served access and unknown billing facts", async () => {
  const row = { id: DEPLOYMENT, execution_class: "container", access: null, status: "deploying",
    billing: { state: null, accrued_this_month_usd: 0 } };
  await withResponses([[200, { deployments: [row] }], [200, { deployment: row }]], async (client) => {
    const listed = payload(await client.callTool({ name: "varity_deploy_status", arguments: {} }));
    const detail = payload(await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: DEPLOYMENT } }));
    assert.equal(listed.data.deployments[0].access, null);
    assert.equal(detail.data.deployment.access, null);
    assert.equal(detail.data.deployment.billing.accrued_this_month_usd, "unavailable");
    assert.deepEqual(listed.data.deployments[0].billing, detail.data.deployment.billing);
  });
});

const { createServer } = await import("node:http");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const { fileURLToPath } = await import("node:url");

test("built stdio customer journey reaches the public HTTP seam and preserves quote/create/access/delete truth", { timeout: 20_000 }, async () => {
  const requests = [];
  const expected = [
    ["GET", "/api/deployment-profiles?workload=gpu&execution_class=container&contract_version=gpu-container-profiles-v2", 200, CATALOG],
    ["POST", "/api/pricing/accelerator-quote", 200, QUOTE],
    ["POST", "/api/deployments", 202, { deployment_id: DEPLOYMENT, status: "deploying" }],
    ["GET", `/api/deployments/${DEPLOYMENT}`, 200, { deployment: { id: DEPLOYMENT, execution_class: "container", access: ACCESS, status: "live", billing: { state: "active" } } }],
    ["DELETE", `/api/deployments/${DEPLOYMENT}`, 202, { run_id: "delete-run", status: "deleting" }],
    ["GET", "/api/deployments/runs/delete-run", 200, { public_status: "deleting", outcome: null }],
    ["GET", `/api/deployments/${DEPLOYMENT}`, 200, { deployment: { id: DEPLOYMENT, execution_class: "container", access: null, status: "deleted", billing: { state: "stopped" } } }],
  ];
  const http = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const response = expected[requests.length];
    requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined, headers: req.headers });
    res.writeHead(response?.[2] ?? 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response?.[3] ?? { code: "unexpected_request" }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.VARITY_MCP_SMOKE_ENTRYPOINT ?? fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { VARITY_API_KEY: "fixture-key", VARITY_GATEWAY_URL: `http://127.0.0.1:${http.address().port}` }, stderr: "pipe" });
  const client = new Client({ name: "gpu-stdio-contract", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "varity_gpu_containers_create"));
    const invoke = async (name, args) => payload(await client.callTool({ name, arguments: args }));
    const catalog = await invoke("varity_gpu_containers_profiles", {});
    assert.deepEqual(catalog.data, CATALOG);
    const quote = await invoke("varity_gpu_containers_quote", { profile_id: PROFILE });
    assert.deepEqual(quote.data, QUOTE);
    const created = await invoke("varity_gpu_containers_create", { ...CREATE_INPUT, accelerator_quote_token: quote.data.quote_token });
    assert.equal(created.data.status, "deploying");
    const live = await invoke("varity_deploy_status", { deployment_id: DEPLOYMENT });
    assert.deepEqual(live.data.deployment.access, ACCESS);
    assert.match(live.message, /SSH access available/);
    const deletion = await invoke("varity_delete_deployment", { deployment: DEPLOYMENT });
    assert.equal(deletion.data.deleted, false);
    assert.match(deletion.message, /billing stop is not proven/);
    const stopped = await invoke("varity_deploy_status", { deployment_id: DEPLOYMENT });
    assert.equal(stopped.data.deployment.billing.state, "stopped");
    assert.equal(stopped.data.deployment.access, null);
    assert.deepEqual(requests.map((r) => [r.method, r.path]), expected.map((r) => r.slice(0, 2)));
    assert.deepEqual(requests[1].body, { execution_class: "container", profile_id: PROFILE });
    assert.deepEqual(requests[2].body, { name: "gpu-worker", execution_class: "container", profile_id: PROFILE,
      ssh_public_key: CREATE_INPUT.ssh_public_key, accelerator_quote_token: QUOTE.quote_token });
    assert.equal(requests[2].headers["idempotency-key"], "gpu-retry-key-01");
    for (const request of requests) assert.equal(request.headers.authorization, "Bearer fixture-key");
  } finally {
    await client.close();
    await transport.close();
    await new Promise((resolve) => http.close(resolve));
  }
});
