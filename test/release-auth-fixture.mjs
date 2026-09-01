import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

const fixture = new URL("../scripts/release-auth-fixture.mjs", import.meta.url);
const acceptedToken = "fixture-accepted-token-never-print";
const rejectedToken = "fixture-rejected-token-never-print";

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

test("release authentication fixture is fail-closed and credential-opaque", async (t) => {
  const port = await reservePort();
  const child = spawn(process.execPath, [fixture.pathname], {
    env: {
      ...process.env,
      RELEASE_AUTH_FIXTURE_TOKEN: acceptedToken,
      RELEASE_AUTH_FIXTURE_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });

  const deadline = Date.now() + 10_000;
  let health;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      health = await fetch("http://127.0.0.1:" + port + "/health");
      if (health.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert(health?.ok, Buffer.concat(stderr).toString("utf8") || "fixture did not start");
  assert.equal(health.headers.get("cache-control"), "no-store");

  const rejected = await fetch("http://127.0.0.1:" + port + "/api/auth/verify", {
    method: "POST",
    headers: { Authorization: "Bearer " + rejectedToken },
  });
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { error: "invalid_token" });

  const accepted = await fetch("http://127.0.0.1:" + port + "/api/auth/verify", {
    method: "POST",
    headers: { Authorization: "Bearer " + acceptedToken },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    user_id: "release-gate-principal",
    scopes: ["read"],
  });

  child.kill("SIGTERM");
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
  const diagnostics = Buffer.concat(stderr).toString("utf8");
  assert.match(diagnostics, /release-auth-fixture: ready/);
  assert.doesNotMatch(diagnostics, new RegExp(acceptedToken));
  assert.doesNotMatch(diagnostics, new RegExp(rejectedToken));
});
