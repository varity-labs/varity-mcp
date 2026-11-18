/**
 * PLAN row A5 stdio smoke: the published entry point (`dist/index.js`) over a
 * real stdio pipe lists varity_login and varity_logout; varity_login fails safe
 * with plain words while sign-in is not live, and, once it is, a headless
 * process returns a device code without blocking. Fake authorization server.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import { startFakeAuthorizationServer } from "./fake-authorization-server.mjs";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const fake = await startFakeAuthorizationServer();
const home = mkdtempSync(join(tmpdir(), "mcp-a5-stdio-"));
after(async () => {
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

async function stdioClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    // CI=true makes the process headless: device flow, no browser.
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CI: "true", VARITY_GATEWAY_URL: fake.base },
    stderr: "ignore",
  });
  const client = new Client({ name: "a5-stdio", version: "1" });
  await client.connect(transport);
  return client;
}

const payload = (result) => JSON.parse(result.content[0].text);

test("stdio: login and logout are listed; sign-in not live fails safe; live headless returns a code", async () => {
  const client = await stdioClient();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("varity_login") && names.includes("varity_logout"));

    fake.state.live = false;
    const down = payload(await client.callTool({ name: "varity_login", arguments: {} }));
    assert.equal(down.error.code, "SIGN_IN_UNAVAILABLE");
    assert.match(down.error.message, /^Browser sign-in isn't available right now\. You can connect with a deploy key instead/);

    fake.state.live = true;
    const pending = payload(await client.callTool({ name: "varity_login", arguments: {} }));
    assert.equal(pending.data.status, "pending");
    assert.equal(pending.data.code, "BCDF-GHJK");

    const out = payload(await client.callTool({ name: "varity_logout", arguments: {} }));
    assert.equal(out.data.signed_in, false);
  } finally {
    await client.close();
  }
});
