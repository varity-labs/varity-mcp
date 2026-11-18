/**
 * P9-ENV (plan rev 9, V9-1..V9-4, V9-14): varity_set_env reads values only
 * from the project's own .env (inside the project folder after symlinks are
 * resolved), sends all keys in ONE PATCH /api/deployments/:id/env without
 * `replace`, never retries, says the app restarts, and no value ever reaches
 * a response, an error, stderr or telemetry. Template deploy takes required
 * env the same way; both paths share one value scrub (`withoutValues`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

const SECRET = "sk-test-SECRETVALUE-9f8e7d6c5b4a";
const OTHER = "second \"quoted\" value 42";

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "varity-proj-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** Calls one tool with a stubbed gateway; captures every request, stderr write and the result. */
async function run(name, args, routes) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "set-env", version: "1" });
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
    return { out: JSON.parse(result.content[0].text), raw: result.content[0].text, calls, stderr: stderr.join("") };
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
  assert.match(result.out.message, /Your app restarts to use the new settings; a restart sets aside another monthly maximum until it settles\./);
  assertNoValues(result);
});

test("a gateway error that echoes a value comes back redacted", async () => {
  const dir = project({ ".env": ENV_TEXT });
  const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY", "OTHER"] }, {
    "PATCH /api/deployments/shop/env": [500, { code: "env_update_failed", message: `bad value ${SECRET} and ${OTHER}`, action: `retry with ${SECRET}` }],
  });
  assert.equal(result.out.success, false);
  assert.equal(result.out.error.code, "env_update_failed");
  assertNoValues(result);
  assert.equal(result.calls.filter((call) => call.method === "PATCH").length, 1, "never retried");
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
    assert.equal(result.calls.length, 0);
    assertNoValues(result);
  }
});

test("only .env files inside the project folder are a value source", async () => {
  const outside = project({ ".env": ENV_TEXT });
  const dir = project({ "config.json": `{"API_KEY":"${SECRET}"}`, ".env.local": ENV_TEXT });
  symlinkSync(join(outside, ".env"), join(dir, ".env"));
  mkdirSync(join(dir, "sub"));
  const cases = [
    [{ env_file: "config.json" }, "ENV_FILE_NOT_ALLOWED"],
    [{ env_file: ".env" }, "ENV_FILE_OUTSIDE_PROJECT"],
    [{ env_file: "../x/.env" }, "ENV_FILE_NOT_FOUND"],
    [{ env_file: "sub/.env" }, "ENV_FILE_NOT_FOUND"],
  ];
  for (const [args, code] of cases) {
    const result = await run("varity_set_env", { deployment: "shop", path: dir, keys: ["API_KEY"], ...args }, {});
    assert.equal(result.out.error.code, code, JSON.stringify(args));
    assert.equal(result.calls.length, 0);
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
  assert.equal(missing.calls.length, 0);
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
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["deployment", "env_file", "keys", "path"]);
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
