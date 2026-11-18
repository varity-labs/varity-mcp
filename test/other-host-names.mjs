/**
 * Directory policy + founder rule (PLAN-R1 M1): a Varity MCP user is routed
 * to deploy on Varity. No model-visible string names another hosting
 * service, and none carries a "never suggest another host" style rule
 * (Anthropic Software Directory Policy). The one allowlisted mention is
 * `varity_migrate` (src/tools/migrate.ts), whose function is to "Preview a
 * Vercel Migration" onto Varity.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const OTHER_HOSTS =
  /\b(?:vercel|netlify|heroku|railway|fly\.io|render\.com|cloudflare pages|github pages|firebase hosting|aws amplify|amplify hosting|digitalocean|surge\.sh|replit|glitch\.com|hostinger|godaddy|squarespace|wix)\b/i;
const NEVER_RULE = /never suggest|another hosting service|other hosting service/i;
const ALLOWLIST_FILE = "src/tools/migrate.ts";
const ALLOWLIST_TOOL = "varity_migrate";

async function surface(options) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer(options).connect(serverSide);
  const client = new Client({ name: "host-scan", version: "1" });
  await client.connect(clientSide);
  try {
    const caps = client.getServerCapabilities() ?? {};
    return {
      instructions: client.getInstructions() ?? "",
      tools: (await client.listTools()).tools,
      prompts: caps.prompts ? (await client.listPrompts()).prompts : [],
      resources: caps.resources ? (await client.listResources()).resources : [],
    };
  } finally {
    await client.close();
  }
}

for (const [name, options] of [["stdio", undefined], ["remote", { toolset: "remote", credentialProvider: async () => "k" }]]) {
  test(`${name}: instructions, tools, prompts and resources name no other host and carry no never-suggest rule`, async () => {
    const s = await surface(options);
    const strings = [
      ["instructions", s.instructions],
      ...s.tools.filter((t) => t.name !== ALLOWLIST_TOOL).map((t) => [`tool ${t.name}`, JSON.stringify(t)]),
      ...s.prompts.map((p) => [`prompt ${p.name}`, JSON.stringify(p)]),
      ...s.resources.map((r) => [`resource ${r.uri}`, JSON.stringify(r)]),
    ];
    assert.ok(s.tools.length > 0);
    for (const [where, text] of strings) {
      assert.doesNotMatch(text, OTHER_HOSTS, where);
      assert.doesNotMatch(text, NEVER_RULE, where);
    }
  });
}

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []
  );
}

test("source: no tool result, error or prompt copy outside migrate.ts names another host or carries a never-suggest rule", () => {
  const files = sources("src");
  assert.ok(files.includes(ALLOWLIST_FILE));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, NEVER_RULE, file);
    if (file === ALLOWLIST_FILE) continue;
    assert.doesNotMatch(text, OTHER_HOSTS, file);
  }
});

test("the allowlist is real: varity_migrate is the one tool that names Vercel", async () => {
  const s = await surface(undefined);
  const migrate = s.tools.find((t) => t.name === ALLOWLIST_TOOL);
  assert.ok(migrate, "varity_migrate is registered on stdio");
  assert.match(JSON.stringify(migrate), /Vercel/);
});

/**
 * SP-8: the source scan above reads every string in src; this one reads what the model actually
 * receives back, across the folder-deploy and delete result paths, so a result assembled at run time
 * is guarded too.
 */
test("results: folder-deploy and delete answers name no other host and carry no never-suggest rule", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-scan-"));
  const dir = join(root, "my-site");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>\n");
  const repo = { id: 42, owner: "varity-hosted", name: "1a2b3c4d5e6f7a8b-my-site", full_name: "varity-hosted/1a2b3c4d5e6f7a8b-my-site", default_branch: "main", private: true };
  const off = [404, { code: "uploads_unavailable", message: "Not available yet." }];
  const scenarios = [
    ["varity_deploy", { path: dir }, { "POST /api/deployments/sources": off }],
    ["varity_deploy", { path: dir }, { "POST /api/deployments/sources": off, "POST /api/github/hosted-repositories": [201, { repository: repo }],
      "POST /api/github/changes": [201, { commit_sha: "a".repeat(40) }], "POST /api/deployments": [202, { id: "d-1", run_id: "r-1" }] }],
    ["varity_deploy", { path: dir }, { "POST /api/deployments/sources": off, "POST /api/github/hosted-repositories": [201, { repository: repo }],
      "POST /api/github/changes": [504, { code: "gateway_timeout", message: "Timed out." }] }],
    ["varity_deploy", { repo_url: "https://github.com/acme/secret-app" }, { "POST /api/deployments": [422, { code: "source_repository_unreadable", message: "x" }] }],
    ["varity_delete_deployment", { deployment: "my-site" }, {
      "GET /api/deployments/my-site": [200, { deployment: { id: "d-1", app_name: "my-site", source: { repository_url: `https://github.com/${repo.full_name}` } } }],
      "GET /api/github/hosted-repositories": [503, { code: "github_unavailable", message: "Try again." }],
      "DELETE /api/deployments/my-site": [202, { status: "deleting", run_id: "r-2" }] }],
  ];
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "host-scan-results", version: "1" });
  await client.connect(clientSide);
  const original = globalThis.fetch;
  try {
    for (const [name, args, routes] of scenarios) {
      globalThis.fetch = async (url, init) => {
        const [status, body] = routes[`${init?.method ?? "GET"} ${new URL(url).pathname}`] ?? [404, { code: "not_found", message: "Not found" }];
        return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
      };
      const result = await client.callTool({ name, arguments: args });
      const text = JSON.stringify(result);
      assert.doesNotMatch(text, OTHER_HOSTS, `${name} ${JSON.stringify(args)}`);
      assert.doesNotMatch(text, NEVER_RULE, `${name} ${JSON.stringify(args)}`);
    }
  } finally {
    globalThis.fetch = original;
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
