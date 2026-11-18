/**
 * P9-ENV (plan rev 9, V9-1..V9-4, V9-14): varity_set_env reads values only
 * from the project's own .env (inside the project folder after symlinks are
 * resolved), sends all keys in ONE PATCH /api/deployments/:id/env without
 * `replace`, never retries, says the app restarts, and no value ever reaches
 * a response, an error, stderr or telemetry. Template deploy takes required
 * env the same way; both paths share one value scrub (`withoutValues`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "api-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-setenv-home-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");
const { ElicitRequestSchema, ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

/** Every test project lives under this folder, which the test client declares as its root. */
const WORKSPACE = realpathSync(mkdtempSync(join(tmpdir(), "varity-ws-")));

const SECRET = "sk-test-SECRETVALUE-9f8e7d6c5b4a";
const OTHER = "second \"quoted\" value 42";

function project(files) {
  const dir = mkdtempSync(join(WORKSPACE, "proj-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/**
 * Calls one tool with a stubbed gateway; captures every request, stderr write
 * and the result. The client declares `roots` (default: WORKSPACE) and, when
 * `elicit` is given, answers elicitation with it; without `elicit` the call
 * passes `confirm: true` unless the args say otherwise.
 */
async function run(name, args, routes, { roots = [WORKSPACE], elicit } = {}) {
  // set_env reads the app first (J-19); a running app unless the test says otherwise.
  routes = { "GET /api/deployments/shop": [200, { deployment: { id: "shop", runtime: "dynamic", status: "live" } }], ...routes };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const capabilities = { ...(roots ? { roots: {} } : {}), ...(elicit ? { elicitation: {} } : {}) };
  const client = new Client({ name: "set-env", version: "1" }, { capabilities });
  const asked = [];
  if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params.message); return elicit; });
  if (!elicit && !("confirm" in args)) args = { ...args, confirm: true };
  await client.connect(clientSide);
  const calls = [];
  const stderr = [];
  const original = globalThis.fetch;
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return write(chunk, ...rest); };
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const route = routes[`${init.method} ${path}`] ?? routes[path];
    if (route === "timeout") throw new DOMException("aborted", "AbortError");
    const [status, body] = route ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    const result = await client.callTool({ name, arguments: args });
    return { out: JSON.parse(result.content[0].text), raw: result.content[0].text, calls, stderr: stderr.join(""), asked };
  } finally {
    globalThis.fetch = original;
    process.stderr.write = write;
    await client.close();
  }
}

const ACCEPTED = [202, { id: "d1", status: "redeploying", run_id: "run-1", env: { keys: ["API_KEY", "OTHER"], count: 2 } }];
const ENV_TEXT = `# settings\nexport API_KEY=${SECRET}\nOTHER="${OTHER.replace(/"/g, '\\"')}"\nUNUSED=nope\n`;

function assertNoValues(result) {
  for (const value of [SECRET, OTHER, JSON.stringify(OTHER).slice(1, -1)]) {
    assert.ok(!result.raw.includes(value), `value leaked into output: ${result.raw}`);
    assert.ok(!result.stderr.includes(value), "value leaked into stderr");
  }
}

test("one PATCH with all requested keys, merge only, says the app restarts; values never echoed", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY", "OTHER"] }, {
    "PATCH /api/deployments/shop/env": ACCEPTED,
  });
  const patches = result.calls.filter((call) => call.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, { env: { API_KEY: SECRET, OTHER } }, "only the named keys, no replace");
  assert.equal(result.out.success, true);
  assert.equal(result.out.data.count, 2);
  assert.match(result.out.message, /Your app restarts to use the new settings\. Restarting holds one more month's maximum, released when billing next settles, usually within 20 minutes\./);
  assertNoValues(result);
});

test("a gateway error that echoes a value comes back redacted", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY", "OTHER"] }, {
    "PATCH /api/deployments/shop/env": [400, { code: "invalid_env", message: `bad value ${SECRET} and ${OTHER}`, action: `retry with ${SECRET}` }],
  });
  assert.equal(result.out.success, false);
  assert.equal(result.out.error.code, "invalid_env");
  assertNoValues(result);
  assert.equal(result.calls.filter((call) => call.method === "PATCH").length, 1, "never retried");
});

test("a 5xx env_update_failed may have arrived: status read, never resent, values scrubbed", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"] }, {
    "PATCH /api/deployments/shop/env": [502, { code: "env_update_failed", message: `rejected ${SECRET}`, action: "retry later" }],
    "GET /api/deployments/shop": [200, { deployment: { id: "shop", status: "live" } }],
  });
  assert.equal(result.out.error.code, "ENV_UPDATE_UNCONFIRMED");
  assert.equal(result.calls.filter((call) => call.method === "PATCH").length, 1);
  assert.doesNotMatch(JSON.stringify(result.out), /retry later/);
  assertNoValues(result);
});

test("ordinary values like true or 3000 are scrubbed from strings without breaking the JSON", async () => {
  const dir = project({ ".env": "DEBUG=true\nPORT=3000\n" });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["DEBUG", "PORT"] }, {
    "PATCH /api/deployments/shop/env": [202, { id: "shop", status: "redeploying", run_id: "run-1", env: { keys: ["DEBUG", "PORT"], count: 2 } }],
  });
  assert.equal(result.out.success, true, "valid JSON with a real boolean");
  assert.equal(result.out.data.count, 2);
  assert.equal(result.out.data.deployment, "shop");
});

test("a timeout is never resent: the tool reads the status instead", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"] }, {
    "PATCH /api/deployments/shop/env": "timeout",
    "GET /api/deployments/shop": [200, { deployment: { id: "shop", status: "redeploying" } }],
  });
  assert.equal(result.out.error.code, "ENV_UPDATE_UNCONFIRMED");
  assert.equal(result.calls.filter((call) => call.method === "PATCH").length, 1);
  assert.ok(result.calls.some((call) => call.method === "GET" && call.path === "/api/deployments/shop"));
  assert.match(result.out.error.message, /redeploying/);
  assert.match(result.out.error.suggestion, /Do not send the settings again yet/);
  assertNoValues(result);
});

test("an approval requirement is said plainly (VARITY_DESTRUCTIVE_APPROVAL_REQUIRED on)", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"] }, {
    "PATCH /api/deployments/shop/env": [403, { code: "approval_required", message: "needs X-Varity-Approval-Id", action: "POST /v1/deployment-approvals" }],
  });
  assert.equal(result.out.error.code, "approval_required");
  assert.match(result.out.error.message, /approval/);
  assert.doesNotMatch(JSON.stringify(result.out), /POST \/v1|X-Varity/);
});

test("example files give key names only, never values, and send nothing", async () => {
  for (const name of [".env.example", ".env.sample", ".env.template"]) {
    const dir = project({ [name]: `API_KEY=${SECRET}\n` });
    const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"], env_file: name }, {});
    assert.equal(result.out.error.code, "ENV_FILE_HAS_NO_VALUES", name);
    assert.match(result.out.error.message, /API_KEY/);
    assert.equal(result.calls.filter((call) => call.method !== "GET").length, 0);
    assertNoValues(result);
  }
});

test("only .env files inside the project folder are a value source", async () => {
  const outside = project({ ".env": ENV_TEXT });
  const dir = project({ "config.json": `{"API_KEY":"${SECRET}"}`, ".env.local": ENV_TEXT });
  symlinkSync(join(outside, ".env"), join(dir, ".env"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", ".env"), ENV_TEXT);
  const cases = [
    [{ env_file: "config.json" }, "ENV_FILE_NOT_ALLOWED"],
    [{ env_file: ".env" }, "ENV_FILE_OUTSIDE_PROJECT"],
    [{ env_file: "../x/.env" }, "ENV_FILE_NOT_ALLOWED"],
    [{ env_file: "sub/.env" }, "ENV_FILE_NOT_ALLOWED"],
  ];
  for (const [args, code] of cases) {
    const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"], ...args }, {});
    assert.equal(result.out.error.code, code, JSON.stringify(args));
    assert.equal(result.calls.filter((call) => call.method !== "GET").length, 0);
    assertNoValues(result);
  }
  const local = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"], env_file: ".env.local" }, {
    "PATCH /api/deployments/shop/env": ACCEPTED,
  });
  assert.equal(local.out.success, true, ".env.<name> is a value source");
});

test("every requested key must exist; a missing file is a plain message", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const missing = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY", "NOT_THERE"] }, {});
  assert.equal(missing.out.error.code, "ENV_KEYS_MISSING");
  assert.match(missing.out.error.message, /NOT_THERE/);
  assert.equal(missing.calls.filter((call) => call.method !== "GET").length, 0);
  assertNoValues(missing);
  const none = await run("varity_set_env", { deployment: "shop", path: project({}), keys: ["API_KEY"] }, {});
  assert.equal(none.out.error.code, "ENV_FILE_NOT_FOUND");
  assert.match(none.out.error.suggestion, /Never put the values in chat/);
});

test("the tool takes names, not values, in its arguments", async () => {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "set-env", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  const tool = tools.find((t) => t.name === "varity_set_env");
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["confirm", "deployment", "env_file", "keys", "path"]);
  assert.match(tool.description, /restarts the app/);
});

const TEMPLATE = {
  id: "n8n", name: "n8n", required_env: ["API_KEY"], requiredEnv: ["API_KEY"], private: false,
  pricing: { monthlyUsd: 14 }, certification: { state: "certified" },
};

test("template deploy reads required env from .env and scrubs values from accepted output and errors", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const ok = await run("varity_deploy_template", { template: "n8n", path: dir }, {
    "GET /api/templates/n8n": [200, { template: TEMPLATE }],
    "POST /api/templates/n8n/deploy": [202, { id: "d2", app_name: SECRET, run_id: "run-2" }],
    "GET /api/deployments/runs/run-2": [200, { public_status: "deploying" }],
  });
  const post = ok.calls.find((call) => call.method === "POST");
  assert.deepEqual(post.body.env, { API_KEY: SECRET });
  assert.equal(ok.out.success, true);
  assertNoValues(ok);

  const refused = await run("varity_deploy_template", { template: "n8n", path: dir }, {
    "GET /api/templates/n8n": [200, { template: TEMPLATE }],
    "POST /api/templates/n8n/deploy": [400, { code: "invalid_env", message: `rejected ${SECRET}`, action: `fix ${SECRET}` }],
  });
  assert.equal(refused.out.success, false);
  assertNoValues(refused);

  const noPath = await run("varity_deploy_template", { template: "n8n" }, { "GET /api/templates/n8n": [200, { template: TEMPLATE }] });
  assert.equal(noPath.out.error.code, "SECURE_ENV_CONFIGURATION_REQUIRED");
  assert.match(noPath.out.error.suggestion, /\.env file in their project folder/);
});

test("a project folder outside the client's roots is refused; with no roots, only the working directory is trusted", async () => {
  const outside = mkdtempSync(join(tmpdir(), "varity-outside-"));
  writeFileSync(join(outside, ".env"), ENV_TEXT);
  for (const options of [{}, { roots: null }]) {
    const result = await run("varity_set_env", { deployment: "shop", path: outside, keys: ["API_KEY"] }, {}, options);
    assert.equal(result.out.error.code, "PROJECT_OUTSIDE_WORKSPACE", JSON.stringify(options));
    assert.equal(result.calls.filter((call) => call.method !== "GET").length, 0);
    assertNoValues(result);
  }
});

test("the user confirms key names and the app before anything is sent", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const args = { deployment: "shop", path: dir, keys: ["API_KEY", "OTHER"] };
  const routes = { "PATCH /api/deployments/shop/env": ACCEPTED };

  const declined = await run("varity_set_env", args, routes, { elicit: { action: "decline" } });
  assert.equal(declined.out.error.code, "ENV_NOT_CONFIRMED");
  assert.equal(declined.calls.filter((call) => call.method !== "GET").length, 0, "decline: nothing sent");
  assert.deepEqual(declined.asked, ["Set API_KEY, OTHER on shop? Your app restarts to use the new settings. Restarting holds one more month's maximum, released when billing next settles, usually within 20 minutes."]);
  assertNoValues(declined);

  const accepted = await run("varity_set_env", args, routes, { elicit: { action: "accept", content: { confirm: true } } });
  assert.equal(accepted.out.success, true);
  assert.equal(accepted.calls.filter((call) => call.method === "PATCH").length, 1);

  const unconfirmed = await run("varity_set_env", { ...args, confirm: undefined }, routes);
  assert.equal(unconfirmed.out.data.confirmation_required, true);
  assert.equal(unconfirmed.out.data.sent, false);
  assert.match(unconfirmed.out.message, /^Set API_KEY, OTHER on shop\? Your app restarts to use the new settings\. Restarting holds one more month's maximum, released when billing next settles, usually within 20 minutes\. Nothing has been sent yet\./);
  assert.equal(unconfirmed.calls.filter((call) => call.method !== "GET").length, 0, "no elicitation and no confirm: nothing sent");
  assertNoValues(unconfirmed);
});

test("J-19: a static site is told plainly it has no settings; nothing is asked or sent", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"] }, {
    "GET /api/deployments/shop": [200, { deployment: { id: "shop", runtime: "static", status: "live" } }],
  }, { elicit: { action: "accept", content: { confirm: true } } });
  assert.equal(result.out.error.code, "STATIC_SITE_HAS_NO_SETTINGS");
  assert.match(result.out.error.message, /^shop is a static site: it is served as files, so it has no settings to change\. Settings work on apps that run a server\./);
  assert.equal(result.asked.length, 0, "no confirm question");
  assert.equal(result.calls.filter((call) => call.method === "PATCH").length, 0);
  assertNoValues(result);
});

test("J-19: for a running app the confirm question carries the restart cost note", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"] }, {
    "PATCH /api/deployments/shop/env": ACCEPTED,
  }, { elicit: { action: "accept", content: { confirm: true } } });
  assert.equal(result.out.success, true);
  assert.equal(result.asked.length, 1);
  assert.match(result.asked[0], /Restarting holds one more month's maximum, released when billing next settles, usually within 20 minutes/);
});

test("J-19: a gateway 409 refusal is mapped to plain words with no 'retry later'", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"] }, {
    "PATCH /api/deployments/shop/env": [409, { code: "env_update_failed", message: "Durable environment update was rejected.", action: "retry later", retryable: false }],
  });
  assert.equal(result.out.error.code, "env_update_failed");
  assert.match(result.out.error.message, /did not change the settings on shop/);
  assert.match(result.out.error.message, /Nothing was changed\./);
  assert.doesNotMatch(JSON.stringify(result.out), /Durable environment update|retry later/i);
});
