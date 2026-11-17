/**
 * Every price the MCP renders shows exactly two decimals in USD and the unit
 * the platform states: a monthly maximum for apps and templates, hourly for
 * virtual machines. Fixture shape from the A-GW catalog: `pricing.monthlyUsd`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const TEMPLATE = { id: "demo", name: "Demo", private: false, requiredEnv: [], pricing: { monthlyUsd: 29.6 } };
const RUN_ID = "19c9f0b2-5ffa-4391-a096-dd964787f929";

async function callTool(routes, name, args) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const route = `${init.method} ${new URL(url).pathname}`;
    const [status, body] = routes[route] ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "price-test", version: "1" });
  await client.connect(clientSide);
  try {
    return JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  } finally {
    await client.close();
    globalThis.fetch = original;
  }
}

test("template info: $29.60 per month as a monthly maximum", async () => {
  const out = await callTool({ "GET /api/templates/demo": [200, { template: TEMPLATE }] }, "varity_template_info", { template: "demo" });
  assert.match(out.message, /up to \$29\.60\/month \(monthly maximum, USD\)/);
});

test("template list shows each template's price with two decimals", async () => {
  const out = await callTool({ "GET /api/templates": [200, { templates: [TEMPLATE], count: 1 }] }, "varity_list_templates", {});
  assert.match(out.message, /up to \$29\.60\/month \(monthly maximum, USD\)/);
});

test("template deploy acceptance repeats the monthly maximum", async () => {
  const out = await callTool({
    "GET /api/templates/demo": [200, { template: TEMPLATE }],
    "POST /api/templates/demo/deploy": [202, { id: "d-1", run_id: RUN_ID }],
    [`GET /api/deployments/runs/${RUN_ID}`]: [200, { public_status: "deploying" }],
  }, "varity_deploy_template", { template: "demo" });
  assert.match(out.message, /up to \$29\.60\/month \(monthly maximum, USD\)/);
});

test("cost calculator: monthly maximum, fixed monthly and hourly with two decimals", async () => {
  const max = await callTool({ "GET /api/pricing": [200, { profile: "web-app", monthly_max_usd: 5 }] }, "varity_cost_calculator", { app_profile: "web-app" });
  assert.match(max.message, /up to \$5\.00\/month \(monthly maximum, USD\)/);
  const fixed = await callTool({ "GET /api/pricing": [200, { profile: "x", fixed_monthly_cost_usd: 1234.5 }] }, "varity_cost_calculator", { app_profile: "x" });
  assert.match(fixed.message, /\$1,234\.50\/month \(USD\)/);
  const hourly = await callTool({ "GET /api/pricing": [200, { profile: "y", hourly_cost_usd: 0.4 }] }, "varity_cost_calculator", { app_profile: "y" });
  assert.match(hourly.message, /\$0\.40\/hour \(USD\)/);
});

test("machine create shows the quoted hourly price with two decimals", async () => {
  const out = await callTool({
    "POST /api/pricing/machine-quote": [200, { quote_token: "aq1.token-abcdefgh", hourly_usd: 0.05, authorization_usd: 5 }],
    "POST /api/machines": [202, { machine_id: "m-1", operation: {} }],
  }, "varity_machines_create", {
    name: "vm", profile_id: "mp-0123456789abcdef01234567", os_image: "os-ubuntu-24-04-0123456789ab", ssh_public_key: "ssh-ed25519 AAAA",
  });
  assert.match(out.message, /\$0\.05\/hour \(USD\)/);
});
