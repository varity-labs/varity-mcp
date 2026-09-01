import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

test("HTTP health reports the package release version", async (t) => {
  const port = await reservePort();
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("OTEL_") || name.startsWith("BETTERSTACK_")) delete env[name];
  }

  const child = spawn(
    process.execPath,
    ["dist/index.js", "--transport", "http", "--port", String(port)],
    { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "ignore", "pipe"] },
  );
  t.after(() => child.kill("SIGTERM"));

  const deadline = Date.now() + 30_000;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  assert(response?.ok, "MCP HTTP runtime did not become healthy");
  const body = await response.json();
  assert.deepEqual(body, {
    status: "ok",
    version: packageMetadata.version,
    transport: "http",
  });
});
