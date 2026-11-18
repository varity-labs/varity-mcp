/**
 * U-6 (PLAN distribution-reverify row U-6, journey J-14): a folder with no
 * public GitHub repository is packed, uploaded through IF-UPLOAD and deployed,
 * and every path fails safe and explains plainly when the upload route is
 * unavailable. The gateway is a fetch stub speaking the contract agreed with
 * the U-5 actor: POST /api/deployments/sources -> 201 {source_id, upload_url
 * (gateway-relative), upload_method, upload_headers, max_bytes, expires_at};
 * PUT upload_url with the Bearer and application/gzip -> 200 sealed; refusals
 * 413 source_too_large, 422 source_archive_refused {field}; flag off -> 404
 * not_found / uploads_unavailable; create source:{type:"upload", source_id,
 * client:"mcp"}.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const SECRET_VALUE = "sk_live_DO_NOT_LEAK_7f3a";
const RUN_ID = "19c9f0b2-5ffa-4391-a096-dd964787f929";
const SLOT = (id = "src_0123456789abcdef0123456789abcdef", max = 52428800) => [201, {
  source_id: id,
  upload_url: `/api/deployments/sources/${id}`,
  upload_method: "PUT",
  upload_headers: {},
  max_bytes: max,
  expires_at: "2026-11-18T03:00:00Z",
}];
const SEALED = [200, { state: "sealed", digest: `sha256:${"a".repeat(64)}`, size: 1, file_count: 1, format: "tar.gz" }];
const ACCEPTED = [202, { id: "d-1", app_name: "my-site", status: "deploying", run_id: RUN_ID }];

/** A project folder with source, ignored output, secrets and a link out of the tree. */
function project({ origin } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-u6-"));
  const dir = join(root, "my-site");
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "config", "secrets"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"my-site","scripts":{"build":"vite build"}}\n');
  writeFileSync(join(dir, "index.html"), "<h1>Flour Lane</h1>\n");
  writeFileSync(join(dir, "src", "main.js"), "console.log('hi')\n");
  writeFileSync(join(dir, "src", "deep", "keep.log"), "kept by negation\n");
  writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
  writeFileSync(join(dir, "logs", "a.log"), "noise\n");
  writeFileSync(join(dir, ".gitignore"), "logs/\n*.log\n");
  writeFileSync(join(dir, "src", ".gitignore"), "!deep/keep.log\n");
  writeFileSync(join(dir, ".env"), `STRIPE_KEY=${SECRET_VALUE}\n`);
  writeFileSync(join(dir, ".env.example"), "STRIPE_KEY=\n");
  writeFileSync(join(dir, "server.pem"), `${SECRET_VALUE}\n`);
  writeFileSync(join(dir, "config", "secrets", "db.txt"), `${SECRET_VALUE}\n`);
  symlinkSync(homedir(), join(dir, "home-link"));
  if (origin) {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Routes `METHOD path` to a queue of responses (the last one repeats); records every call with its raw body. */
function stubGateway(routes) {
  const calls = [];
  const original = globalThis.fetch;
  const used = {};
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const route = `${init.method} ${parsed.pathname}`;
    const raw = init.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : undefined;
    calls.push({ route, origin: parsed.origin, headers: init.headers, body, raw: raw instanceof Uint8Array ? Buffer.from(raw) : undefined });
    const queue = routes[route] ?? [[404, { code: "not_found", message: "Not found" }]];
    const index = Math.min(used[route] ?? 0, queue.length - 1);
    used[route] = (used[route] ?? 0) + 1;
    const [status, payload] = queue[index];
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function callTool(routes, args, toolset) {
  const stub = stubGateway(routes);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer(toolset ? { toolset } : undefined).connect(serverSide);
  const client = new Client({ name: "u6-test", version: "1" });
  await client.connect(clientSide);
  try {
    const result = await client.callTool({ name: "varity_deploy", arguments: args });
    const text = result.content[0].text;
    return { text, out: JSON.parse(text), calls: stub.calls };
  } finally {
    await client.close();
    stub.restore();
  }
}

/** Every member of a gzip tar, honoring PAX `path` records; asserts the framing deploy-api requires. */
function members(archive) {
  assert.deepEqual([...archive.subarray(0, 2)], [0x1f, 0x8b], "gzip");
  const tar = gunzipSync(archive);
  const out = [];
  let offset = 0;
  let paxPath;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12), 8);
    const type = field(156, 1);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = /\d+ path=(.*)\n/.exec(data.toString("utf8"))?.[1];
      continue;
    }
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    assert.equal(type, "0", `${name} is a regular file`);
    assert.ok(!name.startsWith("/") && !name.split("/").includes("..") && !name.split("/").includes("."), name);
    out.push({ name, data: data.toString("utf8"), mode: parseInt(field(100, 8), 8) });
  }
  assert.ok(tar.subarray(offset).every((byte) => byte === 0), "only zero blocks after the last member");
  return out;
}

const route = (calls, r) => calls.filter((call) => call.route === r);
const SOURCES = "POST /api/deployments/sources";
const PUT = "PUT /api/deployments/sources/src_0123456789abcdef0123456789abcdef";
const CREATE = "POST /api/deployments";

test("a folder with no GitHub repo is uploaded privately and deployed, secrets kept local by name only", async () => {
  const { dir, cleanup } = project();
  try {
    const { out, text, calls } = await callTool({ [SOURCES]: [SLOT()], [PUT]: [SEALED], [CREATE]: [ACCEPTED] }, { path: dir });
    assert.equal(out.success, true, text);
    assert.deepEqual(calls.slice(0, 3).map((call) => call.route), [SOURCES, PUT, CREATE]);

    const put = route(calls, PUT)[0];
    assert.equal(put.origin, "https://gw.test");
    assert.equal(put.headers.Authorization, "Bearer deploy-key");
    assert.equal(put.headers["Content-Type"], "application/gzip");

    const files = members(put.raw);
    const names = files.map((file) => file.name).sort();
    assert.deepEqual(names, [".env.example", ".gitignore", "index.html", "package.json", "src/.gitignore", "src/deep/keep.log", "src/main.js"]);
    for (const file of files) assert.doesNotMatch(file.data, new RegExp(SECRET_VALUE));

    const create = route(calls, CREATE)[0].body;
    assert.deepEqual(create.source, { type: "upload", source_id: "src_0123456789abcdef0123456789abcdef", client: "mcp" });
    assert.equal(create.repo_url, undefined);
    assert.equal(create.app_name, "my-site");

    assert.match(out.message, /no GitHub repository/);
    assert.match(out.message, /uploaded this folder to Varity \(7 files\); your code stays private/);
    assert.match(out.message, /Left out \d+ ignored items/);
    assert.deepEqual(out.data.secret_files_not_uploaded, [".env", "config/secrets/", "server.pem"]);
    assert.match(out.message, /did not upload them: \.env, config\/secrets\/, server\.pem/);
    assert.doesNotMatch(text, new RegExp(SECRET_VALUE), "a secret value never reaches the output");
  } finally {
    cleanup();
  }
});

for (const [label, refusal] of [
  ["gateway flag off (404 not_found)", [404, { code: "not_found", message: "Not found" }]],
  ["deploy-api flag off (404 uploads_unavailable)", [404, { code: "uploads_unavailable", message: "Uploads are not enabled" }]],
  ["route missing (405)", [405, {}]],
]) {
  test(`upload route unavailable fails safe and explains plainly: ${label}`, async () => {
    const { dir, cleanup } = project();
    try {
      const { out, calls } = await callTool({ [SOURCES]: [refusal] }, { path: dir });
      assert.equal(out.success, false);
      assert.equal(out.error.code, "UPLOAD_UNAVAILABLE");
      assert.match(out.error.message, /not switched on at Varity yet\. Nothing was uploaded, deployed or charged\./);
      assert.match(out.error.suggestion, /varity_list_templates/);
      assert.match(out.error.suggestion, /ask first/);
      assert.deepEqual(calls.map((call) => call.route), [SOURCES], "no upload and no create");
    } finally {
      cleanup();
    }
  });
}

test("a private repo from the folder's origin is deployed by uploading the folder", async () => {
  const { dir, cleanup } = project({ origin: "git@github.com:acme/secret-app.git" });
  try {
    const { out, text, calls } = await callTool({
      [CREATE]: [[422, { code: "source_repository_unreadable", message: "supplied token cannot read" }], ACCEPTED],
      [SOURCES]: [SLOT()],
      [PUT]: [SEALED],
    }, { path: dir });
    assert.equal(out.success, true, text);
    const creates = route(calls, CREATE);
    assert.equal(creates[0].body.repo_url, "https://github.com/acme/secret-app");
    assert.equal(creates[1].body.repo_url, undefined);
    assert.equal(creates[1].body.source.type, "upload");
    assert.equal(creates[1].body.app_name, "secret-app");
    assert.match(out.message, /cannot read this project's GitHub repository \(it is private\), so I uploaded this folder/);
    assert.ok(!members(route(calls, PUT)[0].raw).some((file) => file.name.startsWith(".git/")), "no .git in the upload");
  } finally {
    cleanup();
  }
});

test("a private repo while the upload route is off still explains, deploys nothing", async () => {
  const { dir, cleanup } = project({ origin: "https://github.com/acme/secret-app.git" });
  try {
    const { out, calls } = await callTool({
      [CREATE]: [[422, { code: "source_repository_unreadable", message: "x" }]],
    }, { path: dir });
    assert.equal(out.error.code, "UPLOAD_UNAVAILABLE");
    assert.match(out.error.message, /Nothing was uploaded, deployed or charged/);
    assert.equal(route(calls, CREATE).length, 1);
    assert.equal(route(calls, PUT).length, 0);
  } finally {
    cleanup();
  }
});

test("J-14: an explicit private repo_url offers the folder upload first, publishing last", async () => {
  const { out } = await callTool({
    [CREATE]: [[422, { code: "source_repository_unreadable", message: "supplied token cannot read" }]],
  }, { repo_url: "https://github.com/acme/secret-app" });
  assert.equal(out.error.code, "source_repository_unreadable");
  assert.match(out.error.message, /private or does not exist\. Nothing was deployed and nothing was charged\./);
  const suggestion = out.error.suggestion;
  const upload = suggestion.indexOf("I'll upload your project folder to Varity instead; your code stays private.");
  const template = suggestion.indexOf("varity_list_templates");
  const publish = suggestion.indexOf("--visibility public");
  assert.ok(upload >= 0 && upload < template && template < publish, suggestion);
  assert.match(suggestion, /source "upload"/);
});

test("the remote toolset keeps the no-folder copy: no upload promise, no path or source input", async () => {
  const { out } = await callTool({
    [CREATE]: [[422, { code: "source_repository_unreadable", message: "x" }]],
  }, { repo_url: "https://github.com/acme/secret-app" }, "remote");
  assert.doesNotMatch(`${out.error.message} ${out.error.suggestion}`, /folder|upload/i);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer({ toolset: "remote" }).connect(serverSide);
  const client = new Client({ name: "u6-remote", version: "1" });
  await client.connect(clientSide);
  const tool = (await client.listTools()).tools.find((t) => t.name === "varity_deploy");
  await client.close();
  assert.equal(tool.inputSchema.properties.path, undefined);
  assert.equal(tool.inputSchema.properties.source, undefined);
});

test("server refusals are explained plainly and never start a deploy", async () => {
  const { dir, cleanup } = project();
  try {
    const secret = await callTool({
      [SOURCES]: [SLOT()],
      [PUT]: [[422, { code: "source_archive_refused", field: "secret_path", message: "archive contains a secret file: app/id_ed25519" }]],
    }, { path: dir });
    assert.equal(secret.out.error.code, "source_archive_refused");
    assert.match(secret.out.error.message, /looks like a secret/);
    assert.match(secret.out.error.message, /Nothing was deployed or charged/);
    assert.equal(route(secret.calls, CREATE).length, 0);

    const big = await callTool({ [SOURCES]: [SLOT()], [PUT]: [[413, { code: "source_too_large", message: "too large" }]] }, { path: dir });
    assert.equal(big.out.error.code, "source_too_large");
    assert.match(big.out.error.message, /over the upload size limit/);
    assert.equal(route(big.calls, CREATE).length, 0);

    const busy = await callTool({ [SOURCES]: [SLOT()], [PUT]: [[503, { code: "source_store_unavailable", message: "Storage is busy." }]] }, { path: dir });
    assert.match(busy.out.error.suggestion, /Wait a minute/);
    assert.equal(route(busy.calls, CREATE).length, 0);
  } finally {
    cleanup();
  }
});

test("an archive over the served max_bytes is never sent", async () => {
  const { dir, cleanup } = project();
  try {
    const { out, calls } = await callTool({ [SOURCES]: [SLOT(undefined, 10)] }, { path: dir });
    assert.equal(out.error.code, "source_too_large");
    assert.match(out.error.message, /Nothing was uploaded, deployed or charged/);
    assert.equal(route(calls, PUT).length, 0);
  } finally {
    cleanup();
  }
});

test("the key is never sent to an upload_url outside the gateway API", async () => {
  const { dir, cleanup } = project();
  try {
    const slot = SLOT();
    slot[1] = { ...slot[1], upload_url: "https://elsewhere.test/put" };
    const { out, calls } = await callTool({ [SOURCES]: [slot] }, { path: dir });
    assert.equal(out.success, false);
    assert.deepEqual(calls.map((call) => call.route), [SOURCES]);
  } finally {
    cleanup();
  }
});

test("no path and no origin: asks for the project path, uploads nothing", async () => {
  const cwd = process.cwd();
  const { dir, cleanup } = project();
  process.chdir(dir);
  try {
    const { out, calls } = await callTool({}, {});
    assert.equal(out.error.code, "PROJECT_PATH_REQUIRED");
    assert.equal(calls.length, 0);
  } finally {
    process.chdir(cwd);
    cleanup();
  }
});

test("the home folder is never uploaded", async () => {
  const { out, calls } = await callTool({ [SOURCES]: [SLOT()] }, { path: homedir(), source: "upload" });
  assert.equal(out.error.code, "NOT_A_PROJECT_FOLDER");
  assert.equal(calls.length, 0);
});

test("deploying the folder again re-packs it and sends a new source_id", async () => {
  const { dir, cleanup } = project();
  try {
    const second = "src_ffffffffffffffffffffffffffffffff";
    const first = await callTool({ [SOURCES]: [SLOT()], [PUT]: [SEALED], [CREATE]: [ACCEPTED] }, { path: dir, app_name: "my-site" });
    writeFileSync(join(dir, "index.html"), "<h1>Flour Lane v2</h1>\n");
    const again = await callTool({
      [SOURCES]: [SLOT(second)],
      [`PUT /api/deployments/sources/${second}`]: [SEALED],
      [CREATE]: [ACCEPTED],
    }, { path: dir, app_name: "my-site", source: "upload" });
    assert.equal(first.out.success && again.out.success, true);
    assert.equal(route(again.calls, CREATE)[0].body.source.source_id, second);
    const html = members(route(again.calls, `PUT /api/deployments/sources/${second}`)[0].raw).find((f) => f.name === "index.html");
    assert.match(html.data, /v2/);
    assert.notEqual(route(first.calls, CREATE)[0].headers["Idempotency-Key"], route(again.calls, CREATE)[0].headers["Idempotency-Key"]);
  } finally {
    cleanup();
  }
});

test("long and non-ASCII paths are carried exactly (PAX), executables keep their bit", async () => {
  const { buildSourceArchive } = await import("../dist/utils/source-archive.js");
  const long = `${"a".repeat(120)}/${"b".repeat(90)}/${"c".repeat(110)}.js`;
  const { archive } = await buildSourceArchive([
    { path: long, data: Buffer.from("x"), executable: false },
    { path: "café/menü.txt", data: Buffer.from("y"), executable: false },
    { path: "bin/run.sh", data: Buffer.from("#!/bin/sh\n"), executable: true },
  ]);
  const files = members(archive);
  assert.deepEqual(files.map((file) => file.name), ["bin/run.sh", long, "café/menü.txt"].sort());
  assert.equal(files.find((file) => file.name === "bin/run.sh").mode, 0o755);
});

test("IF-SECRET-PATHS: the shared table (env templates allowed)", async () => {
  const { isSecretPath } = await import("../dist/utils/source-archive.js");
  for (const path of [".env", ".env.local", "app/.env.production", "id_rsa", "keys/id_ed25519", "cert.pem", "a.key", "store.jks",
    "secrets/x.txt", "deep/.ssh/config", ".aws/credentials", ".npmrc", ".git-credentials", "my-service-account.json",
    ".config/gcloud/creds.json", "x/.docker/config.json", ".config/gh/hosts.yml", "secrets.json", "credentials"]) {
    assert.equal(isSecretPath(path), true, path);
  }
  for (const path of [".env.example", ".env.sample", ".env.template", "src/env.ts", "README.md", "keyboard.js", "secret-santa.md"]) {
    assert.equal(isSecretPath(path), false, path);
  }
});

test("review: a worktree or submodule .git file is never packed", async () => {
  const { dir, cleanup } = project();
  try {
    writeFileSync(join(dir, ".git"), "gitdir: /home/someone/repo/.git/worktrees/x\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", ".GIT"), "gitdir: ../.git/modules/sub\n");
    writeFileSync(join(dir, "sub", "a.js"), "1\n");
    const { out, calls } = await callTool({ [SOURCES]: [SLOT()], [PUT]: [SEALED], [CREATE]: [ACCEPTED] }, { path: dir });
    assert.equal(out.success, true);
    const names = members(route(calls, PUT)[0].raw).map((file) => file.name);
    assert.ok(names.includes("sub/a.js"));
    assert.ok(!names.some((name) => name.split("/").some((segment) => segment.toLowerCase() === ".git")), names.join(","));
  } finally {
    cleanup();
  }
});

test("review: many empty files are refused locally on the server's tar-stream ratio", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-u6-ratio-"));
  try {
    for (let i = 0; i < 3000; i += 1) writeFileSync(join(root, `f${i}.txt`), "");
    const { out, calls } = await callTool({ [SOURCES]: [SLOT()] }, { path: root, source: "upload" });
    assert.equal(out.error.code, "FOLDER_NOT_UPLOADABLE");
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: deploy-api's upload flag off at create time is explained plainly", async () => {
  const { dir, cleanup } = project();
  try {
    const { out } = await callTool({
      [SOURCES]: [SLOT()], [PUT]: [SEALED], [CREATE]: [[404, { code: "uploads_unavailable", message: "x" }]],
    }, { path: dir });
    assert.equal(out.error.code, "UPLOAD_UNAVAILABLE");
    assert.match(out.error.message, /not switched on at Varity yet\. Nothing was deployed or charged\./);
  } finally {
    cleanup();
  }
});

test("review: a folder above the home folder is never uploaded", async () => {
  const { out, calls } = await callTool({ [SOURCES]: [SLOT()] }, { path: join(homedir(), ".."), source: "upload" });
  assert.equal(out.error.code, "NOT_A_PROJECT_FOLDER");
  assert.equal(calls.length, 0);
});

test("review: 408 and 429 upload refusals say wait and retry, and start no deploy", async () => {
  const { dir, cleanup } = project();
  try {
    for (const refusal of [[408, { code: "upload_timeout", message: "The upload took too long." }], [429, { code: "upload_capacity", message: "Too many uploads right now." }]]) {
      const { out, calls } = await callTool({ [SOURCES]: [SLOT()], [PUT]: [refusal] }, { path: dir });
      assert.equal(out.error.code, refusal[1].code);
      assert.match(out.error.suggestion, /Wait a minute/);
      assert.equal(route(calls, CREATE).length, 0);
    }
  } finally {
    cleanup();
  }
});
