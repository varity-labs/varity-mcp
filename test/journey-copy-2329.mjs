/**
 * Journey 2.3.29 BLOCK rows (evidence distribution-reverify-20261116/phase3/
 * journey-2.3.29/FIX-ROWS.md): J-23 a non-coder with no public GitHub gets
 * Varity's no-GitHub path first (Chat and Build), never "a different hosting
 * service"; U-ADV the deploy tool never promises a folder upload before one
 * works; E3 a private repo never leads with the upload once the route said it
 * is off; J-22 the hold release time is the measured one; T2 the sign-in
 * remedy is true whether or not browser sign-in is on; VM-LIST the machines
 * list stays readable; README leads with the setup that works today.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-2329-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const CHAT_AND_BUILD = "https://developer.store.varity.so/dashboard/ai-gateway?tab=chat&mode=build";
const NO_FOLDER_YET = "Varity can't take a folder from this computer yet";
const SOURCES = "POST /api/deployments/sources";
const CREATE = "POST /api/deployments";

async function connect() {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "journey-2329", version: "1" });
  await client.connect(clientSide);
  return client;
}

/** `METHOD path` → [status, body]; anything else answers 404 not_found. */
async function call(name, args, routes) {
  const client = await connect();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const { pathname, search } = new URL(url);
    const [status, body] = routes[`${init?.method ?? "GET"} ${pathname}${search}`] ?? routes[`${init?.method ?? "GET"} ${pathname}`] ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    const result = await client.callTool({ name, arguments: args });
    return { out: JSON.parse(result.content[0].text), size: result.content[0].text.length };
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

function folder() {
  const root = mkdtempSync(join(tmpdir(), "bakery-"));
  const dir = join(root, "bakery-site");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<h1>Flour Lane</h1>\n");
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Order of first appearance; -1 when absent. */
const at = (text, needle) => text.indexOf(needle);

// U-ADV first: the descriptions are checked before any upload attempt in this process.
test("U-ADV: varity_deploy never promises a folder upload or private code before an upload works", async () => {
  const client = await connect();
  const tool = (await client.listTools()).tools.find((t) => t.name === "varity_deploy");
  await client.close();
  const text = [tool.description, tool.inputSchema.properties.path.description, tool.inputSchema.properties.source.description].join(" ");
  assert.doesNotMatch(text, /is uploaded to Varity directly|code stays private|no GitHub needed/i, text);
  assert.match(tool.description, new RegExp(NO_FOLDER_YET.replace(/[.?*+^$()|[\]\\]/g, "\\$&")), tool.description);
});

test("E3 (fresh process): a private repo does not lead with an upload nobody has seen work", async () => {
  const { out } = await call("varity_deploy", { repo_url: "https://github.com/acme/secret-app" }, {
    [CREATE]: [422, { code: "source_repository_unreadable", message: "x" }],
  });
  const s = out.error.suggestion;
  assert.doesNotMatch(s, /I'll upload your project folder|your code stays private/, s);
  assert.ok(at(s, CHAT_AND_BUILD) >= 0 && at(s, CHAT_AND_BUILD) < at(s, "varity_list_templates"), s);
  assert.ok(at(s, "varity_list_templates") < at(s, "--visibility public"), s);
});

test("J-23: upload off → Chat and Build first, templates next, public GitHub last; never another host", async () => {
  const { dir, cleanup } = folder();
  try {
    const { out } = await call("varity_deploy", { path: dir }, {
      [SOURCES]: [404, { code: "uploads_unavailable", message: "Deploying uploaded files is not available yet." }],
    });
    assert.equal(out.error.code, "UPLOAD_UNAVAILABLE");
    const s = out.error.suggestion;
    assert.match(s, new RegExp(NO_FOLDER_YET));
    assert.match(s, /No GitHub needed/);
    const chat = at(s, CHAT_AND_BUILD);
    assert.ok(chat >= 0 && chat < at(s, "varity_list_templates") && at(s, "varity_list_templates") < at(s, "GitHub repository"), s);
    assert.match(s, /never suggest another hosting service/i);
    assert.doesNotMatch(s.replace(/never suggest another hosting service/i, ""), /hosting service/i);
  } finally {
    cleanup();
  }
});

test("E3: after the upload route said it is off, a private repo never offers the upload", async () => {
  const { out } = await call("varity_deploy", { repo_url: "https://github.com/acme/secret-app" }, {
    [CREATE]: [422, { code: "source_repository_unreadable", message: "x" }],
  });
  const s = out.error.suggestion;
  assert.doesNotMatch(s, /source "upload"|upload your project folder/i, s);
  assert.match(s, new RegExp(NO_FOLDER_YET));
  assert.ok(at(s, CHAT_AND_BUILD) >= 0 && at(s, CHAT_AND_BUILD) < at(s, "varity_list_templates"), s);
});

test("J-22: the hold release time is the measured one, not 'a few minutes'", async () => {
  const { out } = await call("varity_balance", {}, {
    "GET /api/credits/balance": [200, { availableE8: "10000000000", reservedE8: "100000000", debtE8: "0" }],
  });
  assert.equal(out.success, true, JSON.stringify(out));
  assert.match(out.message, /released when billing next settles, usually within 20 minutes after an app stops/);
  assert.doesNotMatch(out.message, /few minutes/);
});

test("T2: the sign-in remedy is true while browser sign-in is off: it names the deploy key and never says no key is needed", async () => {
  const { DEPLOY_KEY_ACTION } = await import("../dist/utils/public-api.js");
  assert.doesNotMatch(DEPLOY_KEY_ACTION, /No key is needed/i);
  assert.ok(DEPLOY_KEY_ACTION.startsWith("Call varity_login"), DEPLOY_KEY_ACTION);
  assert.match(DEPLOY_KEY_ACTION, /SIGN_IN_UNAVAILABLE/);
  assert.match(DEPLOY_KEY_ACTION, /settings\?tab=api-keys/);
  assert.match(DEPLOY_KEY_ACTION, /VARITY_DEPLOY_KEY/);
  assert.match(DEPLOY_KEY_ACTION, /out of the chat/);
});

const machine = (i, state) => ({
  machine_id: `m-${i}`, name: `box-${i}`, hardware: { cpu_units: 4, memory_mb: 21504, note: "x".repeat(1500) },
  billing: { state }, lifecycle: { status: "succeeded" },
});
const FLEET = [...Array.from({ length: 300 }, (_, i) => machine(i, "stopped")), machine(300, "active"), machine(301, "active"), machine(302, "pending")];

test("VM-LIST: by default only machines still billing are listed, with a count of the rest and how to see them", async () => {
  const { out, size } = await call("varity_machines_list", {}, {
    "GET /api/machines": [200, { machines: FLEET, inventory_status: "complete" }],
  });
  assert.deepEqual(out.data.machines.map((m) => m.machine_id), ["m-300", "m-301", "m-302"]);
  assert.equal(out.data.total_count, 303);
  assert.equal(out.data.not_listed_count, 300);
  assert.match(out.message, /^3 machine\(s\) running or billing\. 300 more with billing stopped are not listed; set include_stopped to list them\.$/);
  assert.ok(size < 20_000, `output ${size} chars`);
});

test("VM-LIST: include_stopped is bounded by limit and says how many were left out", async () => {
  const { out, size } = await call("varity_machines_list", { include_stopped: true, limit: 10 }, {
    "GET /api/machines": [200, { machines: FLEET, inventory_status: "complete" }],
  });
  assert.equal(out.data.machines.length, 10);
  assert.equal(out.data.not_listed_count, 293);
  assert.match(out.message, /^10 of 303 machine\(s\) listed\. 293 more are not listed; raise limit \(up to 100\) to see more\.$/);
  assert.ok(size < 40_000, `output ${size} chars`);
});

test("README: setup leads with the deploy key that works today; browser sign-in is being switched on", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const setup = readme.slice(readme.indexOf("## Prerequisites"));
  const key = setup.indexOf("deploy key");
  const browser = setup.indexOf("browser sign-in");
  assert.ok(key > 0 && browser > key, setup.slice(0, 900));
  assert.match(setup, /being switched on/);
  assert.doesNotMatch(setup, /No key to copy and no restart/);
  assert.match(setup, /https:\/\/developer\.store\.varity\.so\/dashboard\/settings\?tab=api-keys/);
});

test("T2: varity_login's description is true in both states: browser when switched on, else a deploy key in the editor's MCP settings, never in chat", async () => {
  const client = await connect();
  const tool = (await client.listTools()).tools.find((t) => t.name === "varity_login");
  await client.close();
  const d = tool.description;
  assert.doesNotMatch(d, /no key to type or copy|nothing needs restarting/i, d);
  assert.match(d, /I'll open a browser tab: confirm there to connect Varity\./);
  assert.match(d, /SIGN_IN_UNAVAILABLE/);
  assert.match(d, /deploy key/);
  assert.match(d, /editor's MCP settings/);
  assert.match(d, /never (?:typed|pasted) into (?:the )?chat|Never ask the user to (?:type|paste) a key/i);
});

test("J-22: the set_env restart hold uses the measured release time, not 'a few minutes'", async () => {
  const { RESTART_NOTE } = await import("../dist/tools/set-env.js");
  const client = await connect();
  const tool = (await client.listTools()).tools.find((t) => t.name === "varity_set_env");
  await client.close();
  for (const text of [RESTART_NOTE, tool.description]) {
    assert.match(text, /released when billing next settles, usually within 20 minutes/, text);
    assert.doesNotMatch(text, /few minutes/, text);
  }
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /maximum for a few minutes/);
});
