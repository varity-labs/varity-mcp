/**
 * Every public-API request carries a bounded User-Agent naming this package,
 * the MCP client from `initialize`, and the transport. No private value
 * (key, path, repository, account) is in it; `source: "mcp"` stays the
 * canonical create attribution.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer, VERSION } = await import("../dist/server.js");

const UA = /^varity-mcp\/\d+\.\d+\.\d+ \([A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}; transport=stdio\)$/;

async function userAgentFor(clientInfo) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seen.push(init.headers["User-Agent"]);
    return { ok: true, status: 200, json: async () => ({ profile: "web-app", currency: "USD", monthly_max_usd: 5 }) };
  };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client(clientInfo);
  await client.connect(clientSide);
  try {
    await client.callTool({ name: "varity_cost_calculator", arguments: { app_profile: "web-app" } });
    return seen;
  } finally {
    await client.close();
    globalThis.fetch = original;
  }
}

test("the User-Agent names the package version, the client and stdio", async () => {
  const [ua] = await userAgentFor({ name: "claude-code", version: "2.1.0" });
  assert.match(ua, UA);
  assert.equal(ua, `varity-mcp/${VERSION} (claude-code/2.1.0; transport=stdio)`);
});

test("a client name outside the bounded alphabet is normalized, never passed raw", async () => {
  const [ua] = await userAgentFor({ name: "Visual Studio Code (user@host)", version: "1.99.0; evil" });
  assert.match(ua, UA);
  assert.equal(ua, `varity-mcp/${VERSION} (Visual-Studio-Code-user-host/1.99.0-evil; transport=stdio)`);
});
