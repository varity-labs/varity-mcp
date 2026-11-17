/**
 * GPU containers are hidden on every customer surface (founder ruling
 * 2026-10-27): the cost calculator does not advertise `ai-agent-gpu` and
 * refuses it without a request. GPU virtual machines stay available.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

async function connect() {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "cost-test", version: "1" });
  await client.connect(clientSide);
  return client;
}

test("ai-agent-gpu is absent from the advertised profiles", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const cost = tools.find((tool) => tool.name === "varity_cost_calculator");
  assert.doesNotMatch(JSON.stringify(cost), /ai-agent-gpu/);
});

test("a cost call with ai-agent-gpu is refused before any request", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ monthly_max_usd: 1 }) }; };
  const client = await connect();
  try {
    const result = await client.callTool({ name: "varity_cost_calculator", arguments: { app_profile: "ai-agent-gpu" } });
    const out = JSON.parse(result.content[0].text);
    assert.equal(out.success, false);
    assert.equal(out.error.code, "profile_unavailable");
    assert.match(out.error.suggestion, /varity_machines_create/);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    globalThis.fetch = original;
  }
});
