/**
 * H2 (design d1-hosted §2f): one MCP Apps widget, attached only to the
 * read-only render tool `varity_show_deployment` in the remote toolset.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const CARD = "ui://varity/deployment-card.html";
// marketing-canon §4 forbidden vocabulary (zero tolerance in user-facing surfaces).
const CANON_4 = [
  "blockchain", "crypto", "web3", "decentralized", "DePIN", "dApp", "wallet", "gas", "smart contract", "on-chain",
  "L1", "L2", "L3", "rollup", "Akash", "IPFS", "Filecoin", "Arweave", "Privy", "ZeroDev", "thirdweb", "USDC", "AKT",
  "testnet", "mainnet", "sequencer", "bundler", "paymaster", "EntryPoint", "Kernel", "Account Abstraction", "gasless",
];

async function connect(options = { toolset: "remote", credentialProvider: async () => "k" }) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer(options).connect(serverSide);
  const client = new Client({ name: "card-audit", version: "1" });
  await client.connect(clientSide);
  return client;
}

test("resources/read returns the card as an MCP App with no external origins", async () => {
  const client = await connect();
  const { contents } = await client.readResource({ uri: CARD });
  const { resources } = await client.listResources();
  await client.close();
  assert.equal(contents.length, 1);
  assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
  const csp = contents[0]._meta?.ui?.csp;
  assert.ok(csp, "the card declares its CSP");
  for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]) {
    assert.deepEqual(csp[key] ?? [], [], `${key} is empty`);
  }
  assert.deepEqual(resources.map((resource) => resource.uri), [CARD]);
});

test("only varity_show_deployment carries the UI resource", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const withUi = tools.filter((tool) => tool._meta?.ui?.resourceUri || tool._meta?.["ui/resourceUri"]);
  assert.deepEqual(withUi.map((tool) => tool.name), ["varity_show_deployment"]);
  assert.equal(withUi[0]._meta.ui.resourceUri, CARD);
});

test("the card HTML has no canon §4 term, no em or en dash, no billing link and no external URL", async () => {
  const client = await connect();
  const { contents } = await client.readResource({ uri: CARD });
  await client.close();
  const html = contents[0].text;
  assert.ok(html.length > 200);
  for (const term of CANON_4) {
    assert.ok(!new RegExp(`\\b${term}\\b`, "i").test(html), `canon §4 term: ${term}`);
  }
  assert.ok(!/[–—]/.test(html), "no em or en dash");
  assert.ok(!/\/billing/.test(html), "no billing link");
  assert.ok(!/(?:src|href)\s*=\s*["']?https?:/i.test(html), "no external script, style or link");
  assert.match(html, /ui\/open-link/, "Open goes through the host");
  assert.match(html, /varity_deploy_status/, "Refresh calls the read-only status tool");
  assert.ok(!/varity_deploy["'`]/.test(html) && !/varity_deploy_template/.test(html), "the card never deploys");
});

test("varity_show_deployment returns the served card fields as structured content", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, auth: init.headers.Authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        deployment: {
          id: "dep_1",
          operation_deployment_id: "op_1",
          app_name: "shop",
          status: "running",
          public_url: "https://shop.varity.app",
          billing: { currency: "USD", fixed_monthly_cost_usd: "7.00", billing_model: "fixed_monthly", state: "active" },
        },
      }),
    };
  };
  try {
    const client = await connect({ toolset: "remote", credentialProvider: async () => "card-key" });
    const result = await client.callTool({ name: "varity_show_deployment", arguments: { deployment_id: "shop" } });
    await client.close();
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.deepEqual(result.structuredContent, {
      id: "op_1",
      app_name: "shop",
      status: "running",
      url: "https://shop.varity.app",
      monthly_price_usd: "7.00",
      billing_model: "fixed_monthly",
      failure: null,
    });
    assert.deepEqual(seen.map((call) => [call.method, call.url, call.auth]), [
      ["GET", "https://gw.test/api/deployments/shop", "Bearer card-key"],
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("the stdio toolset does not gain the card", async () => {
  const client = await connect({});
  const { tools } = await client.listTools();
  await client.close();
  assert.ok(!tools.some((tool) => tool.name === "varity_show_deployment"));
});
