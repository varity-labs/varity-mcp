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

// A2-0 (IF-CLIENT-ORIGIN `dist`): a plugin manifest sets VARITY_DISTRIBUTION;
// a valid N16 slug (`^[a-z0-9-]{1,32}$`) is appended, anything else is dropped.
const UA_DIST = /^varity-mcp\/\d+\.\d+\.\d+ \([A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}; transport=stdio(?:; dist=[a-z0-9-]{1,32})?\)$/;

async function userAgentWithDistribution(value) {
  if (value === undefined) delete process.env.VARITY_DISTRIBUTION;
  else process.env.VARITY_DISTRIBUTION = value;
  try {
    const [ua] = await userAgentFor({ name: "claude-code", version: "2.1.0" });
    return ua;
  } finally {
    delete process.env.VARITY_DISTRIBUTION;
  }
}

test("a valid distribution slug is appended as dist=<slug>", async () => {
  for (const slug of ["claude-plugin", "npm", "cohort-babson", "a".repeat(32)]) {
    const ua = await userAgentWithDistribution(slug);
    assert.match(ua, UA_DIST);
    assert.equal(ua, `varity-mcp/${VERSION} (claude-code/2.1.0; transport=stdio; dist=${slug})`);
  }
});

test("no or an invalid distribution slug is dropped, never normalized", async () => {
  for (const value of [undefined, "", "Claude-Plugin", "claude plugin", "x;dist=evil", "a".repeat(33), "partner:venice"]) {
    const ua = await userAgentWithDistribution(value);
    assert.match(ua, UA_DIST);
    assert.equal(ua, `varity-mcp/${VERSION} (claude-code/2.1.0; transport=stdio)`, String(value));
  }
});
