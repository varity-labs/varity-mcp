/**
 * P9-DOMAIN (plan rev 9, V9-4, V9-13): varity_domain_add / _verify / _remove
 * over the gateway's owner-scoped custom-domain routes. The DNS line comes
 * from the served claim (recordType, recordName, expectedCname | expectedA +
 * challenge) for a subdomain and an apex; `supported: false` and
 * `custom_domains_not_supported` get one plain message.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "api-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-domain-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

async function run(name, args, routes) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "domain", version: "1" });
  await client.connect(clientSide);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body] = routes[`${init.method} ${path}`] ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    return { out: JSON.parse((await client.callTool({ name, arguments: args })).content[0].text), calls };
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

const SUBDOMAIN = {
  hostname: "app.example.com", recordType: "cname", recordName: "app", expectedCname: "c-7f3a.varity.app",
  state: "pending_dns", dns: { status: "pending" }, certificate: { status: "pending" }, serving: { status: "pending" },
};
const APEX = {
  hostname: "example.com", recordType: "a", recordName: "@", expectedA: "203.0.113.7",
  challenge: { name: "_varity.example.com", value: "tok-123" },
  state: "pending_dns", dns: { status: "pending" }, certificate: { status: "pending" }, serving: { status: "pending" },
};

test("add a subdomain: one PUT and the exact CNAME line", async () => {
  const { out, calls } = await run("varity_domain_add", { deployment: "shop", hostname: "app.example.com" }, {
    "PUT /api/deployments/shop/domain": [201, { supported: true, domain: SUBDOMAIN }],
  });
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [["PUT", "/api/deployments/shop/domain", { hostname: "app.example.com" }]]);
  assert.equal(out.success, true);
  assert.equal(out.data.dns_instructions, 'At the company where the domain is registered, add a CNAME record with Host "app" and Value "c-7f3a.varity.app" for app.example.com.');
  assert.match(out.message, /Once the record is added, I'll check it for you/);
  assert.doesNotMatch(out.message, /run varity_domain_verify/);
});

test("add an apex: the A record and the TXT ownership record", async () => {
  const { out } = await run("varity_domain_add", { deployment: "shop", hostname: "example.com" }, {
    "PUT /api/deployments/shop/domain": [201, { supported: true, domain: APEX }],
  });
  assert.equal(out.data.dns_instructions,
    'At the company where example.com is registered, add two DNS records: an A record with Host "@" and Value "203.0.113.7", ' +
    'and a TXT record with Host "_varity" and Value "tok-123".');
});

test("verify reports the served state in plain words; a live domain shows no DNS line", async () => {
  const mismatch = await run("varity_domain_verify", { deployment: "shop" }, {
    "POST /api/deployments/shop/domain/verify": [200, { supported: true, domain: { ...SUBDOMAIN, dns: { status: "mismatch" } } }],
  });
  assert.match(mismatch.out.message, /does not match yet/);
  assert.ok(mismatch.out.data.dns_instructions);
  const active = await run("varity_domain_verify", { deployment: "shop" }, {
    "POST /api/deployments/shop/domain/verify": [200, { supported: true, domain: { ...SUBDOMAIN, state: "active" } }],
  });
  assert.match(active.out.message, /app\.example\.com is live at https:\/\/app\.example\.com\./);
  assert.equal("dns_instructions" in active.out.data, false);
});

test("supported:false and custom_domains_not_supported get one plain message", async () => {
  const served = await run("varity_domain_verify", { deployment: "shop" }, {
    "POST /api/deployments/shop/domain/verify": [200, { supported: false, domain: null }],
  });
  const refused = await run("varity_domain_add", { deployment: "shop", hostname: "app.example.com" }, {
    "PUT /api/deployments/shop/domain": [409, { code: "custom_domains_not_supported", message: "Custom domains require a public web endpoint." }],
  });
  for (const { out } of [served, refused]) {
    assert.equal(out.success, false);
    assert.equal(out.error.code, "custom_domains_not_supported");
    assert.match(out.error.message, /no public web address/);
  }
});

test("remove: one DELETE, and the app keeps its Varity address", async () => {
  const { out, calls } = await run("varity_domain_remove", { deployment: "shop" }, {
    "DELETE /api/deployments/shop/domain": [200, { removed: true, domain: null }],
  });
  assert.deepEqual(calls.map((c) => c.method), ["DELETE"]);
  assert.equal(out.data.removed, true);
  assert.match(out.message, /still serves at its Varity address/);
});

test("a claim without recordName names the host part in words, never the full hostname as Host", async () => {
  const { recordName, ...legacy } = SUBDOMAIN;
  const { out } = await run("varity_domain_verify", { deployment: "shop" }, {
    "POST /api/deployments/shop/domain/verify": [200, { supported: true, domain: legacy }],
  });
  assert.match(out.data.dns_instructions, /Host set to the part of app\.example\.com before your domain name/);
});
