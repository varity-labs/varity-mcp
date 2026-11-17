/**
 * Deploy-key order (distribution plan §0): env VARITY_DEPLOY_KEY, then the
 * CLI sign-in file `~/.varitykit/config.json` (`deploy_key`, then `api_key`),
 * then the legacy env alias VARITY_API_KEY. The public AI Gateway docs use
 * VARITY_API_KEY for the inference key, so an exported inference key must
 * not beat a deploy key. Doctor reports which source supplied the key, never
 * the key, and deploy readiness depends on authentication only.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mcp-key-order-"));
process.env.HOME = home;
process.env.VARITY_GATEWAY_URL = "https://gw.test";
delete process.env.VARITY_API_KEY;
delete process.env.VARITY_DEPLOY_KEY;

const { getApiKey } = await import("../dist/utils/config.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const configFile = join(home, ".varitykit", "config.json");
function writeConfig(value) {
  mkdirSync(join(home, ".varitykit"), { recursive: true });
  writeFileSync(configFile, JSON.stringify(value));
}
function reset() {
  delete process.env.VARITY_API_KEY;
  delete process.env.VARITY_DEPLOY_KEY;
  rmSync(join(home, ".varitykit"), { recursive: true, force: true });
}

test("both env vars set: VARITY_DEPLOY_KEY wins", async () => {
  reset();
  process.env.VARITY_API_KEY = "inference-key";
  process.env.VARITY_DEPLOY_KEY = "deploy-key";
  assert.equal(await getApiKey(), "deploy-key");
});

test("inference VARITY_API_KEY env plus a config deploy_key: the config wins", async () => {
  reset();
  process.env.VARITY_API_KEY = "inference-key";
  writeConfig({ deploy_key: "config-deploy-key" });
  assert.equal(await getApiKey(), "config-deploy-key");
});

test("only VARITY_API_KEY: it is still used (legacy alias)", async () => {
  reset();
  process.env.VARITY_API_KEY = "legacy-key";
  assert.equal(await getApiKey(), "legacy-key");
});

test("doctor: deploy ready with a verified key and no varitykit; reports the key source, never the key", async () => {
  reset();
  process.env.VARITY_DEPLOY_KEY = "secret-deploy-key-value";
  const savedPath = process.env.PATH;
  // node and npm stay resolvable; varitykit (and python) are absent.
  const bin = mkdtempSync(join(tmpdir(), "mcp-doctor-bin-"));
  const { symlinkSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  for (const tool of ["node", "npm", "which", "env", "sh"]) {
    try {
      const target = execFileSync("which", [tool], { encoding: "utf8" }).trim();
      if (target) symlinkSync(target, join(bin, tool));
    } catch { /* optional helper */ }
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).pathname, "/api/deployments");
    return { ok: true, status: 200, json: async () => ({ deployments: [] }) };
  };
  process.env.PATH = bin;
  try {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createVarityServer().connect(serverSide);
    const client = new Client({ name: "doctor-test", version: "1" });
    await client.connect(clientSide);
    const result = await client.callTool({ name: "varity_doctor", arguments: {} });
    await client.close();
    const text = result.content[0].text;
    const out = JSON.parse(text);
    assert.equal(out.data.cli_deploy_ready, true);
    assert.equal(out.data.deploy_key_source, "env:VARITY_DEPLOY_KEY");
    const varitykit = out.data.checks.find((check) => check.name === "varitykit CLI");
    assert.equal(varitykit.status, "warn");
    assert.match(varitykit.message, /migrate/);
    assert.doesNotMatch(text, /secret-deploy-key-value/);
  } finally {
    process.env.PATH = savedPath;
    globalThis.fetch = original;
    rmSync(bin, { recursive: true, force: true });
  }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
