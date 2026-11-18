/**
 * Copy-only 2.3.29 (founder ruling 2026-11-18T16:46:48Z, R1 SP-1): this version has no
 * private-copy code, so nothing it shows may promise one. "private copy" is refused
 * unconditionally in tool text, MCP instructions, tool results and the README; 2.3.29 has
 * no release gate and needs none. The stdio rules route the folder to varity_deploy and,
 * on UPLOAD_UNAVAILABLE, to Chat and Build, without promising packing or a kept copy.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-2329-copy-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");
const { CHAT_AND_BUILD_URL } = await import("../dist/utils/public-api.js");

const PRIVATE_COPY = /private copy/i;
const UNRELEASED = /private copy|keeps? (?:a|the|your) (?:copy|folder)|packs it/i;

async function connect(options) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer(options).connect(serverSide);
  const client = new Client({ name: "no-private-copy", version: "1" });
  await client.connect(clientSide);
  return client;
}

test("2.3.29: no tool text or instructions, stdio or hosted, promise a private copy", async () => {
  for (const options of [undefined, { toolset: "remote", credentialProvider: async () => "k" }]) {
    const client = await connect(options);
    try {
      const instructions = client.getInstructions() ?? "";
      assert.doesNotMatch(instructions, UNRELEASED, instructions);
      for (const tool of (await client.listTools()).tools) assert.doesNotMatch(JSON.stringify(tool), PRIVATE_COPY, tool.name);
    } finally {
      await client.close();
    }
  }
});

test("2.3.29: the README and every src string promise no private copy", () => {
  assert.doesNotMatch(readFileSync(new URL("../README.md", import.meta.url), "utf8"), PRIVATE_COPY);
  const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
  for (const file of sources("src")) assert.doesNotMatch(readFileSync(file, "utf8"), PRIVATE_COPY, file);
});

test("2.3.29: folder-deploy results promise no private copy and end in a Varity action", async () => {
  const root = mkdtempSync(join(tmpdir(), "copy-2329-"));
  const dir = join(root, "my-site");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>\n");
  const scenarios = [
    [{ path: dir }, { "POST /api/deployments/sources": [404, { code: "uploads_unavailable", message: "Not available yet." }] }],
    [{ repo_url: "https://github.com/acme/secret-app" }, { "POST /api/deployments": [422, { code: "source_repository_unreadable", message: "x" }] }],
  ];
  const client = await connect();
  const original = globalThis.fetch;
  try {
    for (const [args, routes] of scenarios) {
      globalThis.fetch = async (url, init) => {
        const [status, body] = routes[`${init?.method ?? "GET"} ${new URL(url).pathname}`] ?? [404, { code: "not_found", message: "Not found" }];
        return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
      };
      const result = await client.callTool({ name: "varity_deploy", arguments: args });
      const out = JSON.parse(result.content[0].text);
      assert.doesNotMatch(JSON.stringify(result), PRIVATE_COPY, JSON.stringify(args));
      assert.ok(out.error.message.includes(CHAT_AND_BUILD_URL), out.error.message);
      assert.match(out.error.suggestion, /varity_/);
    }
  } finally {
    globalThis.fetch = original;
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("2.3.29: the stdio rules route the folder to varity_deploy, UPLOAD_UNAVAILABLE to Chat and Build, sign-in to varity_login", async () => {
  const client = await connect();
  const rules = client.getInstructions() ?? "";
  await client.close();
  assert.ok(rules.length <= 512, `${rules.length} characters`);
  assert.match(rules, /varity_deploy with path set to the absolute project folder/);
  assert.ok(rules.includes(`If varity_deploy answers UPLOAD_UNAVAILABLE, offer Varity's Chat and Build: ${CHAT_AND_BUILD_URL}`), rules);
  assert.match(rules, /varity_login/);
  assert.doesNotMatch(rules, /never suggest|hosting service/i);
});
