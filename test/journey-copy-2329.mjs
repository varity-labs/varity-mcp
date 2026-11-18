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
async function call(name, args, routes, shared) {
  const client = shared ?? (await connect());
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const { pathname, search } = new URL(url);
    const [status, body] = routes[`${init?.method ?? "GET"} ${pathname}${search}`] ?? routes[`${init?.method ?? "GET"} ${pathname}`] ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    const result = await client.callTool({ name, arguments: args });
    return { out: JSON.parse(result.content[0].text), size: Buffer.byteLength(result.content[0].text), structured: result.structuredContent };
  } finally {
    globalThis.fetch = original;
    if (!shared) await client.close();
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

/**
 * SP-2 (R1 review spec-95e8809): "private copy" is a promise that is true only while the gateway's
 * hosted-repository route serves deploy keys. The copy is tied to that state by a release gate, not by
 * its wording: a version whose model-visible text or README claims the private copy is published only
 * after that route is live in production with its flag on and its live acceptance passed. So any
 * "private copy" claim (tool text, stdio instructions, README) needs that gate recorded in
 * ARCHITECTURE.md's release sequence; without it the claim is an unreleased promise and this fails.
 */
const PRIVATE_COPY = /private copy/i;
const PRIVATE_COPY_GATE =
  "A version whose tool text, instructions or README promises the private copy is published only after the " +
  "gateway's hosted-repository route serves deploy keys in production (`VARITY_HOSTED_REPOS_DEPLOY_KEYS_ENABLED=true`) " +
  "and its live acceptance has passed";

test("U-ADV/SP-2: a private-copy promise ships only behind the recorded release gate", async () => {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "u-adv", version: "1" });
  await client.connect(clientSide);
  const tool = (await client.listTools()).tools.find((t) => t.name === "varity_deploy");
  const instructions = client.getInstructions() ?? "";
  await client.close();
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const claims = [
    ["varity_deploy description", tool.description],
    ["varity_deploy path", tool.inputSchema.properties.path.description],
    ["varity_deploy source", tool.inputSchema.properties.source.description],
    ["stdio instructions", instructions],
    ["README", readme],
  ].filter(([, text]) => PRIVATE_COPY.test(text)).map(([where]) => where);
  if (claims.length === 0) return;
  const verification = readFileSync(new URL("../ARCHITECTURE.md", import.meta.url), "utf8").split("## Verification")[1] ?? "";
  assert.ok(verification.includes(PRIVATE_COPY_GATE), `private copy promised in ${claims.join(", ")} without the release gate in ARCHITECTURE.md ## Verification`);
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

const UPLOAD_OFF = { [SOURCES]: [404, { code: "uploads_unavailable", message: "Deploying uploaded files is not available yet." }] };

test("J-23: upload off → Chat and Build first, templates next, public GitHub last; never another host", async () => {
  const { dir, cleanup } = folder();
  try {
    const { out } = await call("varity_deploy", { path: dir }, UPLOAD_OFF);
    assert.equal(out.error.code, "UPLOAD_UNAVAILABLE");
    const s = out.error.suggestion;
    assert.match(s, new RegExp(NO_FOLDER_YET));
    assert.match(s, /No GitHub needed/);
    const chat = at(s, CHAT_AND_BUILD);
    assert.ok(chat >= 0 && chat < at(s, "varity_list_templates") && at(s, "varity_list_templates") < at(s, "GitHub repository"), s);
    assert.doesNotMatch(s, /never suggest|hosting service/i);
  } finally {
    cleanup();
  }
});

test("E3: after the upload route said it is off, a private repo never offers the upload (same server)", async () => {
  const client = await connect();
  const { dir, cleanup } = folder();
  let out;
  try {
    assert.equal((await call("varity_deploy", { path: dir }, UPLOAD_OFF, client)).out.error.code, "UPLOAD_UNAVAILABLE");
    ({ out } = await call("varity_deploy", { repo_url: "https://github.com/acme/secret-app" }, {
      [CREATE]: [422, { code: "source_repository_unreadable", message: "x" }],
    }, client));
  } finally {
    cleanup();
    await client.close();
  }
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
const SSH = { protocol: "ssh", host: "203.0.113.5", port: 2222, username: "ubuntu" };
const FLEET = [...Array.from({ length: 300 }, (_, i) => machine(i, "stopped")), { ...machine(300, "active"), access: SSH }, machine(301, "active"), machine(302, "pending")];

test("VM-LIST: by default only machines still billing are listed, with a count of the rest and how to see them", async () => {
  const { out, size } = await call("varity_machines_list", {}, {
    "GET /api/machines": [200, { machines: FLEET, inventory_status: "complete" }],
  });
  assert.equal(out.data.machines.length, 3);
  assert.deepEqual(out.data.machines, [
    "box-300 (m-300): billing active, ssh ubuntu@203.0.113.5 -p 2222",
    "box-301 (m-301): billing active",
    "box-302 (m-302): billing pending",
  ]);
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

test("F4: machines text is one short line per machine; full records only in structured data, bounded at limit 100", async () => {
  const { out, size, structured } = await call("varity_machines_list", { include_stopped: true, limit: 100 }, {
    "GET /api/machines": [200, { machines: FLEET, inventory_status: "complete" }],
  });
  assert.equal(out.data.machines.length, 100);
  for (const line of out.data.machines) assert.equal(typeof line, "string");
  assert.doesNotMatch(JSON.stringify(out), /xxxxxxxxxx/, "no full record in the text");
  assert.ok(size < 12_000, `text ${size} bytes`);
  assert.equal(structured.data.machines.length, 100);
  assert.equal(structured.data.machines[0].hardware.memory_mb, 21504);
});

test("F1: the deploy-key path tells a user without a card about Chat and Build", async () => {
  const { DEPLOY_KEY_ACTION } = await import("../dist/utils/public-api.js");
  const { KEY_SIGN_IN_LINE } = await import("../dist/utils/public-api.js");
  const line = `If the Portal asks for a payment method before it creates the key, you can still put a site online today without a card using Chat and Build: ${CHAT_AND_BUILD}`;
  for (const text of [DEPLOY_KEY_ACTION, KEY_SIGN_IN_LINE]) assert.ok(text.includes(line), text);
});

test("A3: the upload answer belongs to one server: a new server starts unknown", async () => {
  const { out } = await call("varity_deploy", { repo_url: "https://github.com/acme/secret-app" }, {
    [CREATE]: [422, { code: "source_repository_unreadable", message: "x" }],
  });
  assert.match(out.error.suggestion, /you may try varity_deploy with path/);
});

test("A4: a created slot whose upload failed never makes the upload 'available'", async () => {
  const client = await connect();
  const { dir, cleanup } = folder();
  const slot = { source_id: "src_1", upload_url: "/api/deployments/sources/src_1", upload_method: "PUT", upload_headers: {}, max_bytes: 52428800 };
  let out;
  try {
    await call("varity_deploy", { path: dir }, { [SOURCES]: [201, slot], "PUT /api/deployments/sources/src_1": [503, { code: "unavailable" }] }, client);
    ({ out } = await call("varity_deploy", { repo_url: "https://github.com/acme/secret-app" }, {
      [CREATE]: [422, { code: "source_repository_unreadable", message: "x" }],
    }, client));
  } finally {
    cleanup();
    await client.close();
  }
  assert.doesNotMatch(out.error.suggestion, /I'll upload your project folder/);
});

test("A2: the deploy-key line says to restart the editor, and the action reuses that one line", async () => {
  const { DEPLOY_KEY_ACTION } = await import("../dist/utils/public-api.js");
  const { KEY_SIGN_IN_LINE } = await import("../dist/utils/public-api.js");
  assert.match(KEY_SIGN_IN_LINE, /add it as VARITY_DEPLOY_KEY in your editor's MCP settings, then restart your editor or AI assistant\./);
  assert.ok(DEPLOY_KEY_ACTION.includes(`"${KEY_SIGN_IN_LINE}"`), DEPLOY_KEY_ACTION);
});

test("A1/A7: no README line promises no key or no restart; the machines row names the new arguments", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /no key to copy|no restart|No key to copy/i);
  const row = readme.split("\n").find((l) => l.startsWith("| `varity_machines_list`"));
  assert.match(row, /include_stopped/);
  assert.match(row, /limit/);
  const login = readme.split("\n").find((l) => l.startsWith("| `varity_login`"));
  assert.match(login, /deploy key/);
});

test("P1 T3: the error message itself (not only the suggestion) leads with Chat and Build, developers next, GitHub last, no other host", async () => {
  const { dir, cleanup } = folder();
  let off;
  try {
    ({ out: off } = await call("varity_deploy", { path: dir }, UPLOAD_OFF));
  } finally {
    cleanup();
  }
  const { out: priv } = await call("varity_deploy", { repo_url: "https://github.com/acme/secret-app" }, {
    [CREATE]: [422, { code: "source_repository_unreadable", message: "x" }],
  });
  for (const m of [off.error.message, priv.error.message]) {
    const chat = at(m, CHAT_AND_BUILD);
    const dev = at(m, "template");
    const gh = at(m, "public on GitHub");
    assert.ok(chat >= 0 && dev > chat && gh > dev, m);
    assert.match(m, /only if the user asks/i);
    assert.doesNotMatch(m, /never suggest|hosting service/i);
  }
  // r3: the message opens with one quoted paragraph to say verbatim; options and rules come after the quote.
  const said = (m) => m.match(/^Tell the user exactly this: "([^"]+)"/)?.[1];
  assert.equal(said(off.error.message),
    `Varity can't take a folder from this computer yet. Nothing was uploaded, deployed or charged. The way to get it online today without GitHub is Varity's Chat and Build: describe the app, and Varity builds it and publishes it to a live address: ${CHAT_AND_BUILD}`);
  assert.equal(said(priv.error.message),
    `Varity can't read this project's code on GitHub: it is private or does not exist. Nothing was deployed or charged. The way to get it online today without GitHub is Varity's Chat and Build: describe the app, and Varity builds it and publishes it to a live address: ${CHAT_AND_BUILD}`);
});

test("r3/M1: server instructions: stdio routes the local folder to varity_deploy; hosted keeps the repo order; both within 512 characters, no other-host rule", async () => {
  const texts = {};
  for (const [name, options] of [["stdio", undefined], ["remote", { toolset: "remote", credentialProvider: async () => "k" }]]) {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createVarityServer(options).connect(serverSide);
    const client = new Client({ name: "instructions", version: "1" });
    await client.connect(clientSide);
    texts[name] = client.getInstructions();
    await client.close();
  }
  assert.equal(texts.stdio,
    "Varity deploys the folder the user is working in: call varity_deploy with path set to the absolute project folder. " +
    "Varity packs it (honouring .gitignore, keeping secret files on this computer), keeps a private copy and builds it; " +
    "then call varity_deploy_status with the returned id until it is live. Sign in with varity_login; never ask for a key in chat.");
  assert.match(texts.remote, /varity_deploy \(public repo_url or image\)/);
  assert.match(texts.remote, /Never ask the user for a key in chat\./);
  assert.ok(texts.remote.includes(`If the user has no public GitHub repository, offer Varity's Chat and Build first: ${CHAT_AND_BUILD}`), texts.remote);
  // E11: the hosted surface has no local folder, so it carries none of the stdio folder rules.
  assert.doesNotMatch(texts.remote, /absolute project folder|\.gitignore|secret files/);
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(text.length <= 512, `${name}: ${text.length} characters`);
    assert.doesNotMatch(text, /never suggest|hosting service/i, name);
  }
});

test("R2-2: structured and text results agree: same message, counts and profiles; only the machine records are fuller", async () => {
  const profiles = { execution_class: "cpu_virtual_machine", profiles: [{ profile_id: "mp-1" }] };
  const { out, structured } = await call("varity_machines_list", { include_profiles: true }, {
    "GET /api/machines": [200, { machines: FLEET, inventory_status: "complete" }],
    "GET /api/deployment-profiles?workload=cpu&execution_class=cpu_virtual_machine": [200, profiles],
  });
  assert.equal(structured.success, true);
  assert.equal(structured.message, out.message);
  assert.deepEqual(structured.data.profiles, profiles);
  assert.deepEqual(out.data.profiles, profiles);
  assert.equal(structured.data.total_count, out.data.total_count);
  assert.equal(structured.data.not_listed_count, out.data.not_listed_count);
  assert.deepEqual(structured.data.machines[0].access, SSH);
});

test("R2-3: the key line has one home (public-api); login does not re-export it", async () => {
  const login = await import("../dist/tools/login.js");
  assert.equal(login.KEY_SIGN_IN_LINE, undefined);
});
