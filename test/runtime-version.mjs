import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };

test("stdio initialize reports the package release version", async (t) => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("OTEL_") || name.startsWith("BETTERSTACK_")) delete env[name];
  }

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`stdio initialize timed out: ${stderr}`)),
      10_000,
    );
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          clearTimeout(timeout);
          resolve(message);
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`stdio runtime exited ${code}: ${stderr}`));
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "runtime-version-test", version: "1.0.0" },
      },
    }) + "\n");
  });

  assert.equal(response.result.serverInfo.name, "varity");
  assert.equal(response.result.serverInfo.version, packageMetadata.version);
  assert.match(stderr, new RegExp(`Varity MCP Server v${packageMetadata.version} running on stdio`));
});

test("retired transport arguments fail closed", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/index.js", "--transport", "http", "--port", "3100"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unsupported command-line arguments/);
  assert.doesNotMatch(result.stderr, /running on http/i);
});

test("unsupported arguments never echo credential-shaped values", () => {
  const secret = "synthetic-secret-canary";
  const result = spawnSync(
    process.execPath,
    ["dist/index.js", "--token", secret],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unsupported command-line arguments/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test("explicit stdio transport spelling remains compatible", async (t) => {
  const child = spawn(process.execPath, ["dist/index.js", "--transport", "stdio"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "ignore", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`explicit stdio alias did not start: ${stderr}`)), 10_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("running on stdio")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`explicit stdio alias exited ${code}: ${stderr}`));
    });
  });
  assert.equal(child.exitCode, null);
});
