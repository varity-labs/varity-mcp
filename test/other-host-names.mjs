/**
 * Directory policy + founder rule (PLAN-R1 M1): a Varity MCP user is routed
 * to deploy on Varity. No model-visible string names another hosting
 * service, and none carries a "never suggest another host" style rule
 * (Anthropic Software Directory Policy). The one allowlisted mention is
 * `varity_migrate` (src/tools/migrate.ts), whose function is to "Preview a
 * Vercel Migration" onto Varity.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
