/**
 * IF-SERVER-FACTORY and the remote toolset (distribution plan rows H1 and N8,
 * design d1-hosted §2b/§2c, tests (1)-(5) and (7)). The hosted mount (the
 * gateway) builds one server per request with
 * `createVarityServer({ credentialProvider, toolset: "remote" })`; the stdio
 * package keeps calling `createVarityServer()`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
// An env key and a sign-in file exist on this host: the remote toolset must
// never fall back to either.
const home = mkdtempSync(join(tmpdir(), "varity-remote-"));
mkdirSync(join(home, ".varitykit"));
writeFileSync(join(home, ".varitykit", "config.json"), JSON.stringify({ deploy_key: "config-key" }));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.VARITY_DEPLOY_KEY = "env-deploy-key";
process.env.VARITY_API_KEY = "env-legacy-key";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const LOCAL_26 = [
  "varity_agent_info", "varity_balance", "varity_build", "varity_cost_calculator", "varity_create_repo",
  "varity_delete_deployment", "varity_deploy", "varity_deploy_agent", "varity_deploy_logs", "varity_deploy_status",
  "varity_deploy_template", "varity_dev_server", "varity_doctor", "varity_install_deps", "varity_list_agents",
  "varity_list_templates", "varity_login", "varity_machines_create", "varity_machines_delete", "varity_machines_list",
  "varity_migrate", "varity_open_browser", "varity_redeploy", "varity_search_docs", "varity_set_env",
  "varity_template_info",
];

// Distribution plan §2a, copied as literals: readOnly / destructive / idempotent / openWorld.
const READ = [true, false, true, true];
const REMOTE_2A = {
  varity_search_docs: READ,
  varity_cost_calculator: READ,
  varity_balance: READ,
  varity_list_templates: READ,
  varity_template_info: READ,
  varity_deploy_status: READ,
  varity_deploy_logs: READ,
  varity_show_deployment: READ,
  varity_deploy_template: [false, false, false, true],
  varity_deploy: [false, false, false, true],
  varity_redeploy: [false, true, false, true],
  varity_delete_deployment: [false, true, true, true],
};

async function connect(options) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer(options).connect(serverSide);
  const client = new Client({ name: "remote-audit", version: "1" });
  await client.connect(clientSide);
  return client;
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

/** Stub fetch; `respond(url, init)` returns `{status, body}` (default 200 `{}`). */
function stubFetch(respond) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method, auth: init.headers?.Authorization ?? null, ua: init.headers?.["User-Agent"] });
    const { status = 200, body = {}, delayMs = 0 } = (await respond(String(url), init)) ?? {};
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { ok: status < 400, status, json: async () => body };
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test("(1) the default factory still lists the same 26 local tools", async () => {
  for (const options of [undefined, { toolset: "local" }]) {
    const client = await connect(options);
    const { tools } = await client.listTools();
    await client.close();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), LOCAL_26);
  }
});

test("(2)+(7) the remote toolset is exactly the 12-name allow-list with the §2a annotations", async () => {
  const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
  const { tools } = await client.listTools();
  await client.close();
  const actual = Object.fromEntries(tools.map((tool) => {
    const a = tool.annotations ?? {};
    return [tool.name, [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint]];
  }));
  assert.deepEqual(actual, REMOTE_2A);
  for (const tool of tools) {
    assert.ok(typeof tool.title === "string" && tool.title.length > 0, `${tool.name} title`);
  }
});

test("remote varity_deploy takes a repo_url or image, never a local path or files (N25)", async () => {
  const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
  const { tools } = await client.listTools();
  await client.close();
  const deploy = tools.find((tool) => tool.name === "varity_deploy");
  const properties = Object.keys(deploy.inputSchema.properties ?? {});
  assert.ok(properties.includes("repo_url") && properties.includes("image"));
  assert.ok(!properties.includes("path"), "no local path remotely");
  assert.ok(!properties.includes("files"), "files waits for R-29");
  const text = JSON.stringify(tools);
  for (const local of ["varity_create_repo", ".git/config", "varity_login", "varity_doctor"]) {
    assert.ok(!text.includes(local), `remote tool text names ${local}`);
  }
});

test("the remote server sets self-contained instructions within 512 characters", async () => {
  const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
  const instructions = client.getInstructions();
  await client.close();
  assert.equal(typeof instructions, "string");
  assert.ok(instructions.length <= 512, `instructions are ${instructions.length} characters`);
  const order = ["varity_cost_calculator", "varity_deploy", "varity_deploy_status", "varity_show_deployment", "varity_delete_deployment"]
    .map((name) => instructions.indexOf(name));
  assert.ok(order.every((index) => index >= 0), "names every step");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "cost, deploy, status, URL, delete in that order");
  const local = await connect(undefined);
  assert.equal(local.getInstructions(), undefined, "stdio is unchanged");
  await local.close();
});

test("(3) two concurrent remote calls each send their own provider's credential", async () => {
  const stub = stubFetch(async () => ({ delayMs: 20, body: { deployment: { id: "d1", status: "running" } } }));
  try {
    const a = await connect({ toolset: "remote", credentialProvider: async () => "key-A" });
    const b = await connect({ toolset: "remote", credentialProvider: async () => "key-B" });
    await Promise.all([
      a.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "app-a" } }),
      b.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "app-b" } }),
      a.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "app-a" } }),
      b.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "app-b" } }),
    ]);
    await a.close();
    await b.close();
    const byApp = (slug) => stub.seen.filter((call) => call.url.includes(`/api/deployments/${slug}`)).map((call) => call.auth);
    assert.ok(byApp("app-a").length >= 2 && byApp("app-b").length >= 2);
    assert.ok(byApp("app-a").every((auth) => auth === "Bearer key-A"), JSON.stringify(stub.seen));
    assert.ok(byApp("app-b").every((auth) => auth === "Bearer key-B"), JSON.stringify(stub.seen));
  } finally {
    stub.restore();
  }
});

test("(4) a provider returning null gives NOT_AUTHENTICATED with no env or file fallback", async () => {
  const stub = stubFetch(async () => ({ body: {} }));
  try {
    const client = await connect({ toolset: "remote", credentialProvider: async () => null });
    const result = await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "app" } });
    await client.close();
    assert.equal(result.isError, true);
    const body = parse(result);
    assert.equal(body.error.code, "NOT_AUTHENTICATED");
    assert.ok(!/VARITY_DEPLOY_KEY|varitykit|config\.json/.test(body.error.suggestion ?? ""), "no local sign-in advice remotely");
    assert.ok(stub.seen.every((call) => call.auth === null), "no request carried a key");
  } finally {
    stub.restore();
  }
});

test("a stdio server keeps the env deploy key (default provider unchanged)", async () => {
  const stub = stubFetch(async () => ({ body: { deployment: { id: "d1", status: "running" } } }));
  try {
    const client = await connect(undefined);
    await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "app" } });
    await client.close();
    assert.ok(stub.seen.some((call) => call.auth === "Bearer env-deploy-key"));
  } finally {
    stub.restore();
  }
});

const BILLING_CODES = [
  "insufficient_credits", "daily_free_limit_reached", "spending_limit_reached", "subscription_required",
  "wallet_frozen", "payment_method_shared", "quote_expired", "billing_unavailable", "unlisted_billing_code",
];
const PURCHASE = /Add funds|Choose a plan|\/billing|https?:\/\//i;

test("(5) remote billing refusals explain without a link or purchase verb", async () => {
  for (const code of BILLING_CODES) {
    const stub = stubFetch(async (url) => url.includes("/api/pricing")
      ? { body: { credit_policy: { errorCodes: BILLING_CODES } } }
      : { status: 402, body: { code, message: "Upstream billing text with https://example.test/billing" } });
    try {
      const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
      const result = await client.callTool({ name: "varity_deploy", arguments: { repo_url: "https://github.com/o/r" } });
      await client.close();
      assert.equal(result.isError, true);
      assert.equal(parse(result).error.code, code);
      assert.ok(!PURCHASE.test(result.content[0].text), `${code}: ${result.content[0].text}`);
    } finally {
      stub.restore();
    }
  }
});

test("(5) an unavailable remote balance names no billing link", async () => {
  const stub = stubFetch(async () => ({ status: 500, body: {} }));
  try {
    const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
    const result = await client.callTool({ name: "varity_balance", arguments: {} });
    await client.close();
    assert.equal(parse(result).error.code, "balance_unavailable");
    assert.ok(!PURCHASE.test(result.content[0].text), result.content[0].text);
  } finally {
    stub.restore();
  }
});

test("stdio billing copy is unchanged (still links the billing page)", async () => {
  const stub = stubFetch(async (url) => url.includes("/api/pricing")
    ? { body: { credit_policy: { errorCodes: BILLING_CODES } } }
    : { status: 402, body: { code: "insufficient_credits" } });
  try {
    const client = await connect(undefined);
    const result = await client.callTool({ name: "varity_deploy", arguments: { repo_url: "https://github.com/o/r" } });
    await client.close();
    assert.match(parse(result).error.suggestion, /Add funds at https:\/\/developer\.store\.varity\.so\/dashboard\/billing/);
  } finally {
    stub.restore();
  }
});

test("a remote request says transport=streamable_http in the User-Agent", async () => {
  const stub = stubFetch(async () => ({ body: { deployment: { id: "d1", status: "running" } } }));
  try {
    const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
    await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "app" } });
    await client.close();
    assert.match(stub.seen[0].ua, /^varity-mcp\/\d+\.\d+\.\d+ \(remote-audit\/1; transport=streamable_http\)$/);
  } finally {
    stub.restore();
  }
});

test("remote deploy_status never fetches the deployment URL (no server-side probe, SSRF)", async () => {
  const deployment = { id: "d1", status: "running", public_url: "http://169.254.169.254/latest/meta-data/" };
  const stub = stubFetch(async (url) => url.startsWith("https://gw.test/api/deployments/")
    ? { body: { deployment } }
    : url === "https://gw.test/api/deployments" ? { body: { deployments: [deployment] } } : { body: {} });
  try {
    const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
    const one = await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "d1" } });
    const list = await client.callTool({ name: "varity_deploy_status", arguments: {} });
    await client.close();
    assert.ok(stub.seen.every((call) => call.url.startsWith("https://gw.test/")), JSON.stringify(stub.seen.map((c) => c.url)));
    assert.equal(parse(one).data.deployment.http_probe, undefined);
    assert.equal(parse(list).data.deployments[0].http_probe, undefined);
  } finally {
    stub.restore();
  }
});

test("stdio deploy_status keeps its client-side URL probe", async () => {
  const deployment = { id: "d1", status: "running", public_url: "https://app.example.test/" };
  const stub = stubFetch(async (url) => url.startsWith("https://gw.test/api/deployments/") ? { body: { deployment } } : { body: {} });
  try {
    const client = await connect({});
    await client.callTool({ name: "varity_deploy_status", arguments: { deployment_id: "d1" } });
    await client.close();
    assert.ok(stub.seen.some((call) => call.url === "https://app.example.test/"));
  } finally {
    stub.restore();
  }
});

test("(5) with the billing list unreadable or the code unlisted, remote 402/503 text still has no link or purchase verb", async () => {
  const cases = [
    { pricing: { status: 500, body: {} }, status: 402, code: "insufficient_credits" },
    { pricing: { status: 500, body: {} }, status: 402, code: "new_billing_code" },
    { pricing: { body: { credit_policy: { errorCodes: [] } } }, status: 503, code: "upstream_billing_hold" },
    { pricing: { status: 500, body: {} }, status: 503, code: "spending_limit_reached" },
  ];
  for (const { pricing, status, code } of cases) {
    const stub = stubFetch(async (url) => url.includes("/api/pricing")
      ? pricing
      : { status, body: { code, message: "Add funds at https://developer.store.varity.so/dashboard/billing", action: "Choose a plan at https://x.test/billing" } });
    try {
      const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
      const result = await client.callTool({ name: "varity_deploy", arguments: { repo_url: "https://github.com/o/r" } });
      await client.close();
      assert.equal(parse(result).error.code, code);
      assert.ok(!PURCHASE.test(result.content[0].text), `${status} ${code}: ${result.content[0].text}`);
    } finally {
      stub.restore();
    }
  }
});
