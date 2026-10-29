import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createVarityServer, strictToolInputs } from "../dist/server.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_API_KEY = "synthetic-compatibility-key";

async function clientFor(t, server = createVarityServer()) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  t.after(() => server.close());
  await server.connect(serverSide);
  const client = new Client({ name: "schema-compatibility", version: "1" });
  t.after(() => client.close());
  await client.connect(clientSide);
  return client;
}

function gateway(t, respond) {
  const original = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ path: new URL(url).pathname, init });
    const [status, body] = respond(new URL(url).pathname, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}

test("real SDK discovery retains scalar tool schemas and public machine results", async t => {
  const client = await clientFor(t);
  const { tools } = await client.listTools();
  const list = tools.find(tool => tool.name === "varity_machines_list");
  assert.equal(list.inputSchema.additionalProperties, false);
  assert.equal(list.inputSchema.properties.include_profiles.type, "boolean");
  const create = tools.find(tool => tool.name === "varity_machines_create");
  assert.equal(create.inputSchema.properties.additional_storage_gb.minimum, 0);
  assert.equal(create.inputSchema.properties.additional_storage_gb.type, "integer");
  const calls = gateway(t, path => path === "/api/machines"
    ? [200, { machines: [{ machine_id: "machine-1", billing: { state: "active" } }], inventory_status: "complete" }]
    : [200, { profiles: [{ id: "profile-1", os_images: ["image-1"] }] }]);
  const result = await client.callTool({ name: "varity_machines_list", arguments: { include_profiles: true } });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.success, true);
  assert.equal(body.data.machines[0].machine_id, "machine-1");
  assert.equal(body.data.profiles.profiles[0].id, "profile-1");
  assert.deepEqual(calls.map(call => call.path), ["/api/machines", "/api/deployment-profiles"]);
});

test("real SDK keeps strict accepted-name errors and refuses invalid values before public requests", async t => {
  const client = await clientFor(t);
  const calls = gateway(t, () => assert.fail("invalid input must not reach the public API"));
  for (const [name, args, expected] of [
    ["varity_machines_list", { bogus: true }, /Unknown argument\. varity_machines_list accepts only: include_profiles\./],
    ["varity_balance", { bogus: true }, /varity_balance takes no arguments; call it with \{\}\./],
    ["varity_machines_list", { include_profiles: "yes" }, /include_profiles/],
    ["varity_machines_delete", { machine_id: "not-a-guid" }, /machine_id/],
    ["varity_machines_create", { name: "vm", profile_id: "profile", os_image: "image", ssh_public_key: "-----BEGIN OPENSSH PRIVATE KEY-----" }, /Pass the PUBLIC key/],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, expected);
  }
  assert.deepEqual(calls, []);
});

test("real SDK preserves previously accepted generic GUIDs and exact delete custody", async t => {
  const client = await clientFor(t);
  // Accepted by the prior generic GUID validator; not an RFC variant UUID.
  const id = "11111111-2222-3333-4444-555555555555";
  const calls = gateway(t, (_path, init) => init.method === "DELETE"
    ? [202, { machine_id: id, operation: {} }]
    : [200, { machine_id: id, billing: { state: "stopped" } }]);
  const result = await client.callTool({ name: "varity_machines_delete", arguments: { machine_id: id, idempotency_key: "delete-key-1" } });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.data.machine_id, id);
  assert.equal(body.data.billing_stopped, true);
  assert.deepEqual(calls.map(call => call.path), [`/api/machines/${id}`, `/api/machines/${id}`]);
  assert.equal(calls[0].init.headers["Idempotency-Key"], "delete-key-1");
});

test("current strict registration uses bounded collection validation without visiting oversized elements", async t => {
  const server = new McpServer({ name: "bounded-schema", version: "1" });
  strictToolInputs(server);
  let elements = 0;
  let handlers = 0;
  server.registerTool("bounded_collection", { inputSchema: {
    values: z.array(z.string().refine(() => { elements += 1; return true; })).max(2),
  } }, async () => { handlers += 1; return { content: [{ type: "text", text: "ok" }] }; });
  const client = await clientFor(t, server);
  const oversized = await client.callTool({ name: "bounded_collection", arguments: { values: ["a", "b", "c"] } });
  assert.equal(oversized.isError, true);
  assert.equal(elements, 0);
  assert.equal(handlers, 0);
  const valid = await client.callTool({ name: "bounded_collection", arguments: { values: ["a", "b"] } });
  assert.notEqual(valid.isError, true);
  assert.equal(elements, 2);
  assert.equal(handlers, 1);
});
