/**
 * PLAN row A5 (N3, IF-OAUTH; d1-auth §3.1, §3.4, §3.6, §3.9): varity_login
 * connects Varity through a browser confirmation (loopback PKCE S256) or a
 * device code when headless, waits at most a bounded time and resumes a
 * `pending` sign-in, saves the minted key through one atomic 0600 writer, and
 * varity_logout revokes on Varity before deleting locally. Built against a fake
 * authorization server (test/fake-authorization-server.mjs).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after, beforeEach } from "node:test";
import { startFakeAuthorizationServer } from "./fake-authorization-server.mjs";

const fake = await startFakeAuthorizationServer();
const home = mkdtempSync(join(tmpdir(), "mcp-a5-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.VARITY_GATEWAY_URL = fake.base;
delete process.env.VARITY_DEPLOY_KEY;
delete process.env.VARITY_API_KEY;
after(async () => {
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

const oauth = await import("../dist/utils/oauth-login.js");
const config = await import("../dist/utils/config.js");
const login = await import("../dist/tools/login.js");
const { DEPLOY_KEY_ACTION } = await import("../dist/utils/public-api.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dir = join(home, ".varitykit");
const file = join(dir, "config.json");
const readConfig = () => JSON.parse(readFileSync(file, "utf8"));

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  login.resetLoginSessionForTests();
  Object.assign(fake.state, { live: true, endpointsLive: true, issuerOverride: null, revokeStatus: 200, device: null, deviceInterval: 1 });
  fake.state.revokes.length = 0;
  fake.state.authorizeHits.length = 0;
  fake.state.validKeys.clear();
});

async function tools(deps) {
  const server = new McpServer({ name: "a5", version: "1" });
  login.registerLoginTool(server, deps);
  login.registerLogoutTool(server, { baseUrl: fake.base });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "a5-test", version: "1" });
  await client.connect(clientSide);
  return {
    call: async (name) => JSON.parse((await client.callTool({ name, arguments: {} })).content[0].text),
    close: () => client.close(),
  };
}

// ── protocol (src/utils/oauth-login.ts) ──────────────────────────────────────

test("loopback: PKCE S256, state, 127.0.0.1 redirect; the token call proves the verifier", async () => {
  const signIn = await oauth.startLoopbackSignIn(fake.base);
  const url = new URL(signIn.url);
  assert.equal(url.origin + url.pathname, `${fake.base}/api/oauth/authorize`);
  assert.equal(url.searchParams.get("client_id"), "varity-mcp-local");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(url.searchParams.get("state").length >= 43, "state carries 256 bits");
  assert.match(signIn.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(url.searchParams.get("redirect_uri"), signIn.redirectUri);
  await fake.approveInBrowser(signIn.url);
  const grant = await signIn.done;
  assert.match(grant.deployKey, /^vk_/);
  assert.equal(grant.deployKeyId, "key_1".replace("1", String(fake.state.minted)));
  const token = fake.state.tokenCalls.at(-1);
  assert.equal(token.grant_type, "authorization_code");
  assert.equal(createHash("sha256").update(token.code_verifier).digest("base64url"), url.searchParams.get("code_challenge"));
});

test("a callback with another state is ignored and the sign-in keeps listening", async () => {
  const signIn = await oauth.startLoopbackSignIn(fake.base);
  const stray = await fetch(`${signIn.redirectUri}?code=vac_x&state=not-this-login&iss=${encodeURIComponent(fake.base)}`);
  assert.equal(stray.status, 400);
  const page = await fake.approveInBrowser(signIn.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Varity is connected/);
  assert.match((await signIn.done).deployKey, /^vk_/);
});

test("loopback listener is single use: after the first answer nothing listens", async () => {
  const signIn = await oauth.startLoopbackSignIn(fake.base);
  await fake.approveInBrowser(signIn.url);
  await signIn.done;
  await assert.rejects(fetch(signIn.redirectUri, { signal: AbortSignal.timeout(2_000) }));
});

test("an answer naming another issuer is refused (RFC 9207)", async () => {
  const signIn = await oauth.startLoopbackSignIn(fake.base);
  await fake.approveInBrowser(signIn.url, { iss: "https://evil.example" });
  await assert.rejects(signIn.done, /did not come from Varity/);
});

test("device flow: authorization_pending, slow_down adds 5 s, transient 503 keeps polling, then the key", async () => {
  fake.state.deviceInterval = 5;
  const sleeps = [];
  const signIn = await oauth.startDeviceSignIn(fake.base, {
    label: "laptop\u0007",
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 4) fake.state.device.approved = true;
    },
  });
  assert.equal(signIn.userCode, "BCDF-GHJK");
  assert.equal(fake.state.device.label, "laptop", "control characters are stripped from the label");
  fake.state.device.script.push([400, { error: "authorization_pending" }], [400, { error: "slow_down" }], [503, { error: "temporarily_unavailable" }]);
  const grant = await signIn.done;
  assert.match(grant.deployKey, /^vk_/);
  assert.deepEqual(sleeps, [5_000, 5_000, 10_000, 10_000]);
});

test("device flow: a denial in the browser ends sign-in with a plain message", async () => {
  const signIn = await oauth.startDeviceSignIn(fake.base, { sleep: async () => { fake.state.device.denied = true; } });
  await assert.rejects(signIn.done, (error) => error.code === "SIGN_IN_DENIED" && /declined in the browser/.test(error.message));
});

test("discovery gate: not live (404), another issuer or no S256 stops sign-in", async () => {
  fake.state.live = false;
  await assert.rejects(oauth.checkAuthorizationServer(fake.base), (e) => e.code === "SIGN_IN_UNAVAILABLE");
  fake.state.live = true;
  fake.state.issuerOverride = "https://other.example";
  await assert.rejects(oauth.checkAuthorizationServer(fake.base), (e) => e.code === "SIGN_IN_UNAVAILABLE");
  fake.state.issuerOverride = null;
  await oauth.checkAuthorizationServer(fake.base);
  await assert.rejects(oauth.checkAuthorizationServer("http://127.0.0.1:9"), (e) => e.code === "SIGN_IN_UNAVAILABLE");
});

// ── the single writer (src/utils/config.ts) ──────────────────────────────────

test("one atomic writer: 0600 from creation in a 0700 dir, other fields kept, api_key never written", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ api_key: "legacy", gateway_url: "x" }));
  const previous = process.umask(0);
  try {
    await config.updateSignIn({ deploy_key: "vk_dev_new", deploy_key_id: "key_9" });
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readConfig(), { api_key: "legacy", gateway_url: "x", deploy_key: "vk_dev_new", deploy_key_id: "key_9" });
  assert.deepEqual(readdirSync(dir), ["config.json"], "no temporary file is left behind");
  await config.updateSignIn({}, ["deploy_key", "deploy_key_id"]);
  assert.deepEqual(readConfig(), { api_key: "legacy", gateway_url: "x" });
  // Key order is unchanged: the legacy field is still read when no deploy_key is saved.
  assert.equal(await config.getApiKey(), "legacy");
});

test("the writer is the only place the MCP writes the sign-in file", () => {
  const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  for (const path of ["tools/login.ts", "utils/oauth-login.ts", "tools/doctor.ts"]) {
    assert.doesNotMatch(src(path), /writeFile|rename\(|from "node:fs/, `${path} must use updateSignIn`);
  }
  assert.doesNotMatch(src("utils/config.ts"), /api_key"\] =|api_key:/, "api_key is read only");
});

// ── varity_login (src/tools/login.ts) ────────────────────────────────────────

test("varity_login: browser tab, bounded wait returns pending, the next call resumes the same sign-in", async () => {
  const opened = [];
  const t = await tools({ baseUrl: fake.base, waitMs: 50, headless: () => false, openBrowser: async (url) => { opened.push(url); return true; } });
  const first = await t.call("varity_login");
  assert.equal(first.success, true);
  assert.equal(first.data.status, "pending");
  assert.match(first.message, /I opened a browser tab: confirm there to connect Varity/);
  assert.match(first.message, /call varity_login again/);
  assert.match(first.message, /Never ask the user for a key/);
  assert.equal(opened.length, 1);

  const again = await t.call("varity_login");
  assert.equal(again.data.status, "pending");
  assert.equal(again.data.sign_in_url, opened[0], "same sign-in, no new tab");
  assert.equal(opened.length, 1);

  await fake.approveInBrowser(opened[0]);
  const done = await t.call("varity_login");
  assert.equal(done.success, true);
  assert.equal(done.data.authenticated, true);
  assert.match(done.message, /no restart is needed/);
  assert.equal(fake.state.authorizeHits.length, 1);
  const saved = readConfig();
  assert.match(saved.deploy_key, /^vk_/);
  assert.match(saved.deploy_key_id, /^key_/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await config.getApiKey(), saved.deploy_key, "the running process uses the key at once");
  assert.doesNotMatch(JSON.stringify([first, again, done]), /vk_/, "no tool result carries the key");

  const status = await t.call("varity_login");
  assert.match(status.message, /already connected/);
  await t.close();
});

test("varity_login waits for a confirmation that arrives inside the bounded wait", async () => {
  const t = await tools({
    baseUrl: fake.base, waitMs: 10_000, headless: () => false,
    openBrowser: async (url) => { setTimeout(() => void fake.approveInBrowser(url), 50); return true; },
  });
  const result = await t.call("varity_login");
  assert.equal(result.data.authenticated, true);
  await t.close();
});

test("varity_login: a browser that did not open returns the link at once", async () => {
  const t = await tools({ baseUrl: fake.base, waitMs: 10_000, headless: () => false, openBrowser: async () => false });
  const started = Date.now();
  const result = await t.call("varity_login");
  assert.ok(Date.now() - started < 5_000);
  assert.equal(result.data.browser_opened, false);
  assert.match(result.message, /Open this link and confirm there to connect Varity: http/);
  await t.close();
});

test("varity_login headless: device code returned at once, then the next call connects", async () => {
  const t = await tools({ baseUrl: fake.base, waitMs: 5_000, headless: () => true, openBrowser: async () => assert.fail("no browser when headless") });
  const first = await t.call("varity_login");
  assert.equal(first.data.status, "pending");
  assert.equal(first.data.code, "BCDF-GHJK");
  assert.match(first.message, /confirm the code BCDF-GHJK to connect Varity/);
  assert.match(first.message, /Only approve a code you started/);
  fake.state.device.approved = true;
  const done = await t.call("varity_login");
  assert.equal(done.data.authenticated, true);
  assert.match(readConfig().deploy_key, /^vk_/);
  await t.close();
});

test("varity_login fails safe and explains plainly when sign-in is not live yet", async () => {
  fake.state.live = false;
  for (const headless of [false, true]) {
    let opened = false;
    const t = await tools({ baseUrl: fake.base, waitMs: 50, headless: () => headless, openBrowser: async () => { opened = true; return true; } });
    const result = await t.call("varity_login");
    assert.equal(result.success, false);
    assert.equal(result.error.code, "SIGN_IN_UNAVAILABLE");
    assert.match(result.error.message, /^Browser sign-in isn't available right now\. You can connect with a deploy key instead: create one at /);
    assert.doesNotMatch(`${result.error.message} ${result.error.suggestion}`, /few minutes/);
    assert.equal(opened, false, "no browser tab for a server that is not there");
    assert.throws(() => statSync(file), "nothing is written");
    await t.close();
  }
});

test("re-login replaces a rejected saved sign-in and revokes the browser key it replaces", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ deploy_key: "vk_dev_oldrevoked", deploy_key_id: "key_old" }));
  const t = await tools({
    baseUrl: fake.base, waitMs: 10_000, headless: () => false,
    openBrowser: async (url) => { setTimeout(() => void fake.approveInBrowser(url), 20); return true; },
  });
  const result = await t.call("varity_login");
  assert.equal(result.data.authenticated, true);
  assert.notEqual(readConfig().deploy_key, "vk_dev_oldrevoked");
  assert.deepEqual(fake.state.revokes, ["vk_dev_oldrevoked"]);
  await t.close();
});

test("an environment key Varity rejects is named, never replaced behind the user's back", async () => {
  process.env.VARITY_DEPLOY_KEY = "vk_dev_envrejected";
  try {
    const t = await tools({ baseUrl: fake.base, waitMs: 50, headless: () => false, openBrowser: async () => assert.fail("no sign-in") });
    const result = await t.call("varity_login");
    assert.equal(result.error.code, "DEPLOY_KEY_REJECTED");
    assert.match(result.error.message, /VARITY_DEPLOY_KEY/);
    await t.close();
  } finally {
    delete process.env.VARITY_DEPLOY_KEY;
  }
});

// ── varity_logout ────────────────────────────────────────────────────────────

async function signedIn(key = "vk_dev_saved") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ deploy_key: key, deploy_key_id: "key_s", other: 1 }));
  fake.state.validKeys.add(key);
}

test("varity_logout revokes on Varity with the saved key, then deletes it locally", async () => {
  await signedIn();
  const t = await tools({ baseUrl: fake.base });
  const result = await t.call("varity_logout");
  assert.equal(result.success, true);
  assert.equal(result.data.revoked_on_varity, true);
  assert.deepEqual(fake.state.revokes, ["vk_dev_saved"]);
  assert.deepEqual(readConfig(), { other: 1 });
  assert.equal(await config.getApiKey(), null);
  await t.close();
});

test("varity_logout keeps the key when the revoke outcome is unknown or the key still works", async () => {
  for (const status of [503, 404]) {
    await signedIn();
    fake.state.revokeStatus = status;
    const t = await tools({ baseUrl: fake.base });
    const result = await t.call("varity_logout");
    assert.equal(result.error.code, "SIGN_OUT_NOT_CONFIRMED");
    assert.match(result.error.message, /still signed in; nothing was removed/);
    assert.equal(readConfig().deploy_key, "vk_dev_saved");
    await t.close();
  }
  await signedIn();
  fake.state.revokeStatus = 401; // refused, yet the API still accepts the key
  let t = await tools({ baseUrl: fake.base });
  let result = await t.call("varity_logout");
  assert.equal(result.error.code, "SIGN_OUT_NOT_CONFIRMED");
  assert.equal(readConfig().deploy_key, "vk_dev_saved");
  await t.close();

  fake.state.validKeys.clear(); // refused and the API rejects it too: it is dead, forget it
  t = await tools({ baseUrl: fake.base });
  result = await t.call("varity_logout");
  assert.equal(result.success, true);
  assert.equal(result.data.revoked_on_varity, false);
  assert.equal(readConfig().deploy_key, undefined);
  await t.close();
});

// ── wording (non-coder lens, journey row J-15) ──────────────────────────────

test("every key remedy leads with the browser sign-in; no paste prompt or terminal step anywhere", async () => {
  // T2 (journey 2.3.29): browser sign-in first, the deploy key when it answers SIGN_IN_UNAVAILABLE.
  assert.match(DEPLOY_KEY_ACTION, /^Call varity_login to connect\. If browser sign-in is switched on, it opens a browser tab/);
  assert.ok(DEPLOY_KEY_ACTION.indexOf("VARITY_DEPLOY_KEY") > DEPLOY_KEY_ACTION.indexOf("browser tab"), "deploy key second");
  const { createVarityServer } = await import("../dist/server.js");
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "wording", version: "1" });
  await client.connect(clientSide);
  const { tools: listed } = await client.listTools();
  await client.close();
  const forbidden = /paste|hidden prompt|trusted terminal|varitykit auth login/i;
  for (const tool of listed) assert.doesNotMatch(tool.description, forbidden, tool.name);
  for (const path of ["tools/login.ts", "utils/public-api.ts", "tools/doctor.ts", "utils/oauth-login.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"), forbidden, path);
  }
  const loginTool = listed.find((tool) => tool.name === "varity_login");
  assert.match(loginTool.description, /I'll open a browser tab: confirm there to connect Varity/);
  assert.ok(listed.some((tool) => tool.name === "varity_logout"));
});

test("doctor says signed in (source: sign-in file), never the key", async () => {
  const { verifyAuthentication } = await import("../dist/tools/doctor.js");
  const check = await verifyAuthentication("vk_dev_secret", async () => ({}), "config:~/.varitykit/config.json");
  assert.equal(check.status, "pass");
  assert.match(check.message, /Signed in to Varity \(source: sign-in file\)/);
  assert.doesNotMatch(JSON.stringify(check), /vk_dev_secret/);
  const missing = await verifyAuthentication(null);
  assert.match(missing.message, /Not signed in to Varity yet/);
  assert.match(missing.fix, /^Call varity_login/);
});

// ── review fixes (independent review of 84f96e0) ─────────────────────────────

test("review 1: metadata served but /api/oauth not enabled fails safe before any tab opens", async () => {
  fake.state.endpointsLive = false;
  try {
    await assert.rejects(oauth.checkAuthorizationServer(fake.base), (e) => e.code === "SIGN_IN_UNAVAILABLE");
    let opened = false;
    const t = await tools({ baseUrl: fake.base, waitMs: 50, headless: () => false, openBrowser: async () => { opened = true; return true; } });
    const result = await t.call("varity_login");
    assert.equal(result.error.code, "SIGN_IN_UNAVAILABLE");
    assert.equal(opened, false);
    await t.close();
  } finally {
    fake.state.endpointsLive = true;
  }
});

test("review 2: the browser opener never passes the sign-in URL through a shell", () => {
  const url = `${fake.base}/api/oauth/authorize?response_type=code&client_id=varity-mcp-local&state=a`;
  assert.deepEqual(login.browserCommand("win32", url), { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
  assert.deepEqual(login.browserCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(login.browserCommand("linux", url), { command: "xdg-open", args: [url] });
});

test("review 3: two concurrent varity_login calls share one sign-in (one tab, one key)", async () => {
  const opened = [];
  const t = await tools({ baseUrl: fake.base, waitMs: 3_000, headless: () => false, openBrowser: async (url) => { opened.push(url); return true; } });
  const both = Promise.all([t.call("varity_login"), t.call("varity_login")]);
  while (opened.length === 0) await new Promise((r) => setTimeout(r, 10));
  await fake.approveInBrowser(opened[0]);
  const [a, b] = await both;
  assert.equal(opened.length, 1);
  assert.equal(fake.state.authorizeHits.length, 1);
  assert.equal(a.data.authenticated, true);
  assert.equal(b.data.authenticated, true);
  await t.close();
});

test("review 4: a sign-in that finished unseen does not outlive logout", async () => {
  const opened = [];
  const t = await tools({ baseUrl: fake.base, waitMs: 30, headless: () => false, openBrowser: async (url) => { opened.push(url); return true; } });
  assert.equal((await t.call("varity_login")).data.status, "pending");
  await fake.approveInBrowser(opened[0]);
  while (!readConfigSafe()?.deploy_key) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await t.call("varity_logout")).success, true);
  const next = await t.call("varity_login");
  assert.equal(next.data.status, "pending", "a fresh sign-in starts; it does not claim to be connected");
  assert.equal(opened.length, 2);
  await t.close();
});

function readConfigSafe() {
  try { return readConfig(); } catch { return null; }
}

test("review 5: logout names a key that still connects this computer (legacy api_key or environment)", async () => {
  await signedIn();
  const saved = readConfig();
  writeFileSync(file, JSON.stringify({ ...saved, api_key: "vk_dev_legacy" }));
  const t = await tools({ baseUrl: fake.base });
  const result = await t.call("varity_logout");
  assert.equal(result.success, true);
  assert.equal(result.data.still_connected_by, "the older api_key field in ~/.varitykit/config.json");
  assert.match(result.message, /still connected/);
  assert.equal(readConfig().api_key, "vk_dev_legacy", "api_key is never written");

  writeFileSync(file, JSON.stringify({ api_key: "vk_dev_legacy" }));
  const only = await t.call("varity_logout");
  assert.equal(only.data.still_connected_by, "the older api_key field in ~/.varitykit/config.json");
  assert.doesNotMatch(only.message, /^This computer is not signed in/);

  rmSync(file);
  process.env.VARITY_DEPLOY_KEY = "vk_dev_env";
  try {
    const env = await t.call("varity_logout");
    assert.equal(env.data.still_connected_by, "VARITY_DEPLOY_KEY in the MCP server environment");
  } finally {
    delete process.env.VARITY_DEPLOY_KEY;
  }
  await t.close();
});

test("review 6: logout while sign-out is not live says so plainly and keeps the key", async () => {
  await signedIn();
  fake.state.endpointsLive = false;
  try {
    const t = await tools({ baseUrl: fake.base });
    const result = await t.call("varity_logout");
    assert.equal(result.error.code, "SIGN_OUT_NOT_CONFIRMED");
    assert.match(result.error.message, /Signing out through Varity isn't available yet/);
    assert.equal(readConfig().deploy_key, "vk_dev_saved");
    await t.close();
  } finally {
    fake.state.endpointsLive = true;
  }
});

test("review 7: the writer refuses a corrupt or non-object file and a symlinked file, and loses nothing", async () => {
  const { symlinkSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  for (const content of ["{not json", "[1,2]"]) {
    writeFileSync(file, content);
    await assert.rejects(config.updateSignIn({ deploy_key: "vk_dev_x" }), /could not be read as settings/);
    assert.equal(readFileSync(file, "utf8"), content, "left untouched");
  }
  rmSync(file);
  const target = join(home, "elsewhere.json");
  writeFileSync(target, "{}");
  symlinkSync(target, file);
  await assert.rejects(config.updateSignIn({ deploy_key: "vk_dev_x" }), /is a link/);
  rmSync(file);
  rmSync(target);
});

test("review 7: login with a corrupt sign-in file names the file, not the home folder, and revokes the new key", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "{not json");
  const t = await tools({
    baseUrl: fake.base, waitMs: 10_000, headless: () => false,
    openBrowser: async (url) => { setTimeout(() => void fake.approveInBrowser(url), 20); return true; },
  });
  const result = await t.call("varity_login");
  assert.equal(result.error.code, "SIGN_IN_NOT_SAVED");
  assert.match(result.error.message, /~\/\.varitykit\/config\.json could not be read as settings/);
  assert.equal(fake.state.revokes.length, 1, "the unsaved key was revoked");
  await t.close();
});

test("review 8: the device label is the host name only (the server adds the client name)", async () => {
  const t = await tools({ baseUrl: fake.base, waitMs: 30, headless: () => true, openBrowser: async () => false });
  await t.call("varity_login");
  const { hostname } = await import("node:os");
  assert.equal(fake.state.device.label, hostname().slice(0, 64));
  await t.close();
});
