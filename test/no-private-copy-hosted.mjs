/**
 * Rescoped from 2.3.29's no-private-copy test (PLAN-2.3.30 §2.1, STD-3). In 2.3.30 the
 * stdio folder copy is behind the release gate in ARCHITECTURE.md ## Verification
 * (journey-copy-2329.mjs pins it). What stays true without that gate:
 * - the hosted toolset has no folder, so its instructions and tools promise no private copy
 *   (varity_delete_deployment's conditional cleanup sentence, "If Varity saved a private
 *   copy ... that copy is deleted too", promises nothing and is the one mention allowed);
 * - with the hosted-repository route off (the flag-off rollback state), a folder deploy
 *   promises no private copy and ends in Chat and Build and a varity_ tool.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-hosted-copy-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");
const { CHAT_AND_BUILD_URL } = await import("../dist/utils/public-api.js");

const PRIVATE_COPY = /private copy/i;
const UNRELEASED = /private copy|keeps? (?:a|the|your) (?:copy|folder)|packs it/i;
/** The delete tool's cleanup clause: a condition on an existing copy, not a promise to make one. */
const CLEANUP_CLAUSE = /If Varity saved a private copy of a folder for this app, that copy is deleted too\./;

async function connect(options) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer(options).connect(serverSide);
  const client = new Client({ name: "no-private-copy", version: "1" });
  await client.connect(clientSide);
  return client;
}

test("hosted: the remote toolset's instructions and tools promise no private copy", async () => {
  const client = await connect({ toolset: "remote", credentialProvider: async () => "k" });
  try {
    const instructions = client.getInstructions() ?? "";
    assert.doesNotMatch(instructions, UNRELEASED, instructions);
    for (const tool of (await client.listTools()).tools) {
      assert.doesNotMatch(JSON.stringify(tool).replace(CLEANUP_CLAUSE, ""), PRIVATE_COPY, tool.name);
    }
  } finally {
    await client.close();
  }
});

test("hosted route off: folder-deploy results promise no private copy and end in a Varity action", async () => {
  const root = mkdtempSync(join(tmpdir(), "copy-hosted-off-"));
  const dir = join(root, "my-site");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>\n");
  const hostedOff = { "POST /api/github/hosted-repositories": [404, { code: "hosted_repositories_unavailable", message: "Not available." }] };
  const scenarios = [
    [{ path: dir }, { ...hostedOff, "POST /api/deployments/sources": [404, { code: "uploads_unavailable", message: "Not available yet." }] }],
    [{ repo_url: "https://github.com/acme/secret-app" }, { ...hostedOff, "POST /api/deployments": [422, { code: "source_repository_unreadable", message: "x" }] }],
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
