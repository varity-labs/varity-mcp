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
  assert.match(html, /name: "varity_show_deployment"/, "Refresh calls the read-only card tool");
  assert.ok(!/varity_(?:deploy|deploy_template|redeploy|delete_deployment)["'`]/.test(html), "the card never deploys or deletes");
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

// The card's inline script runs in a minimal fake frame: postMessage
// custody (parent-only sender, pinned host origin) and the Open URL rule.
const vm = await import("node:vm");
const { DEPLOYMENT_CARD_HTML } = await import("../dist/apps/deployment-card-html.js");

function cardFrame() {
  const sent = [];
  const parent = { postMessage: (message, target) => sent.push({ message, target }) };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = {};
      elements.set(id, { textContent: "", hidden: false, disabled: false, className: "",
        addEventListener: (type, fn) => { listeners[type] = fn; }, click: () => listeners.click?.() });
    }
    return elements.get(id);
  };
  const windowListeners = [];
  const window = { parent, addEventListener: (type, fn) => { if (type === "message") windowListeners.push(fn); } };
  const document = { getElementById: element, querySelectorAll: () => [] };
  const script = DEPLOYMENT_CARD_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInNewContext(script, { window, document, URL, Promise, JSON, String });
  const dispatch = (data, { source = parent, origin = "https://host.example" } = {}) =>
    windowListeners.forEach((fn) => fn({ data, source, origin }));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { sent, element, dispatch, flush, parent };
}

const CARD_RESULT = (url) => ({
  jsonrpc: "2.0", method: "ui/notifications/tool-result",
  params: { structuredContent: { id: "op_1", app_name: "shop", status: "running", url, monthly_price_usd: "7.00", billing_model: "fixed_monthly", failure: null } },
});

async function initialized(origin = "https://host.example") {
  const frame = cardFrame();
  const init = frame.sent[0].message;
  assert.equal(init.method, "ui/initialize");
  assert.equal(frame.sent[0].target, "*", "the host origin is unknown before it answers");
  frame.dispatch({ jsonrpc: "2.0", id: init.id, result: {} }, { origin });
  await frame.flush();
  return frame;
}

test("card: messages from any sender other than the parent frame are dropped", async () => {
  const frame = cardFrame();
  const init = frame.sent[0].message;
  frame.dispatch({ jsonrpc: "2.0", id: init.id, result: {} }, { source: {}, origin: "https://evil.example" });
  await frame.flush();
  assert.equal(frame.sent.length, 1, "a non-parent answer does not complete initialize");
  const ok = await initialized();
  ok.dispatch(CARD_RESULT("https://shop.varity.app"), { source: {} });
  assert.equal(ok.element("name").textContent, "", "a non-parent tool result is not rendered");
});

test("card: the host origin from ui/initialize is pinned; other origins are dropped", async () => {
  const frame = await initialized("https://host.example");
  assert.equal(frame.sent[1].message.method, "ui/notifications/initialized");
  assert.equal(frame.sent[1].target, "https://host.example", "later messages target the pinned origin");
  frame.dispatch(CARD_RESULT("https://evil.example"), { origin: "https://other.example" });
  assert.equal(frame.element("name").textContent, "", "another origin is dropped");
  frame.dispatch(CARD_RESULT("https://shop.varity.app"), { origin: "https://host.example" });
  assert.equal(frame.element("name").textContent, "shop");
});

test("card: before initialize completes, only the initialize answer is accepted", async () => {
  const frame = cardFrame();
  frame.dispatch(CARD_RESULT("https://shop.varity.app"), { origin: "https://evil.example" });
  assert.equal(frame.element("name").textContent, "", "an unsolicited first message cannot pin the origin");
});

test("card: Open sends only http(s) URLs to ui/open-link", async () => {
  for (const [url, allowed] of [
    ["https://shop.varity.app/", true], ["http://shop.varity.app/", true],
    ["javascript:alert(1)", false], ["data:text/html,x", false], ["file:///etc/passwd", false], ["not a url", false],
  ]) {
    const frame = await initialized();
    frame.dispatch(CARD_RESULT(url));
    const before = frame.sent.length;
    frame.element("open").click();
    const opened = frame.sent.slice(before).filter((entry) => entry.message.method === "ui/open-link");
    assert.equal(opened.length, allowed ? 1 : 0, url);
    assert.equal(frame.element("open").disabled, !allowed, url);
    if (allowed) assert.equal(opened[0].message.params.url, url);
  }
});

test("card: Refresh re-renders the served failure reason from varity_show_deployment", async () => {
  const frame = await initialized();
  frame.dispatch(CARD_RESULT("https://shop.varity.app"));
  frame.element("refresh").click();
  const call = frame.sent.at(-1).message;
  assert.equal(call.method, "tools/call");
  assert.deepEqual(JSON.parse(JSON.stringify(call.params)), { name: "varity_show_deployment", arguments: { deployment_id: "op_1" } });
  frame.dispatch({ jsonrpc: "2.0", id: call.id, result: { structuredContent: {
    id: "op_1", app_name: "shop", status: "failed", url: null, monthly_price_usd: "7.00", billing_model: "fixed_monthly",
    failure: "Varity could not accept this deploy as it is set up, so the app is not online.",
  } } });
  await frame.flush();
  assert.equal(frame.element("failure").textContent, "Varity could not accept this deploy as it is set up, so the app is not online.");
  assert.equal(frame.element("failure").hidden, false);
});

test("varity_show_deployment states the run view's failure reason like varity_deploy_status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => String(url).includes("/runs/")
      ? { public_status: "failed", outcome: { classification: "expected_rejection", code: "configuration_rejected", action_code: "check_configuration" } }
      : { deployment: { id: "dep_1", app_name: "shop", status: "failed", run_id: "run_1" } },
  });
  try {
    const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
    const result = await client.callTool({ name: "varity_show_deployment", arguments: { deployment_id: "shop" } });
    await client.close();
    assert.equal(result.structuredContent.failure, "Varity could not accept this deploy as it is set up, so the app is not online.");
  } finally {
    globalThis.fetch = original;
  }
});
