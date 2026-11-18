/**
 * P9-DEEPLINK README part (plan rev 9, V9-12): each one-click link decodes,
 * in its vendor's documented format, to `npx -y @varity-labs/mcp@latest` with
 * no env and no key placeholder; every README install command uses @latest.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const SERVER = { command: "npx", args: ["-y", "@varity-labs/mcp@latest"] };

function link(prefix) {
  const found = readme.match(new RegExp(`${prefix.replace(/[.?]/g, "\\$&")}\\S+`));
  assert.ok(found, `${prefix} link present`);
  return found[0];
}

function assertNoSecretSlot(config) {
  assert.equal("env" in config, false, "no env block");
  assert.doesNotMatch(JSON.stringify(config), /KEY|TOKEN|SECRET|<|\$\{/i, "no key placeholder");
}

test("Cursor: name=varity and base64 config of the server object", () => {
  const url = new URL(link("cursor://anysphere.cursor-deeplink/mcp/install?"));
  assert.equal(url.searchParams.get("name"), "varity");
  const config = JSON.parse(Buffer.from(url.searchParams.get("config"), "base64").toString("utf8"));
  assert.deepEqual(config, SERVER);
  assertNoSecretSlot(config);
});

for (const scheme of ["vscode:", "vscode-insiders:"]) {
  test(`${scheme} mcp/install with the URL-encoded JSON {name, command, args}`, () => {
    const raw = link(`${scheme}mcp/install?`);
    const config = JSON.parse(decodeURIComponent(raw.slice(`${scheme}mcp/install?`.length)));
    assert.deepEqual(config, { name: "varity", ...SERVER });
    assertNoSecretSlot(config);
  });
}

test("every README install command uses @varity-labs/mcp@latest", () => {
  const installs = readme.match(/npx -y @varity-labs\/mcp\S*|"@varity-labs\/mcp[^"]*"/g) ?? [];
  assert.ok(installs.length >= 5);
  for (const install of installs) assert.match(install, /@varity-labs\/mcp@latest/, install);
});

test("GitHub does not open editor links, so the README points at the docs page", () => {
  assert.match(readme, /\[Varity MCP docs page\]\(https:\/\/docs\.varity\.so\/ai-tools\/mcp-server-spec\/\)/);
});
