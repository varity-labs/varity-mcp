import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

async function startReceiver() {
  const requests = [];
  const receiver = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "Content-Type": "application/x-protobuf" });
      response.end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  assert.equal(typeof address, "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) =>
      receiver.close((error) => error ? reject(error) : resolve())),
  };
}

test("standard OTEL environment reaches all local OTLP HTTP signal paths without exporting its credential", async () => {
  const receiver = await startReceiver();

  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = receiver.endpoint;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer%20synthetic-otlp-token";
  process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "2000";

  const {
    flushTelemetry,
    instrumentMcpServer,
    startTelemetry,
    stopTelemetry,
  } = await import("../dist/telemetry.js");
  assert.equal(startTelemetry({ version: "test", transport: "http" }), true);

  const server = new McpServer({ name: "otlp-test", version: "1.0.0" });
  instrumentMcpServer(server, "http");
  server.registerTool("otlp_tool", { description: "OTLP path test" }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const client = new Client({ name: "otlp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.callTool({ name: "otlp_tool", arguments: {} });
  await flushTelemetry();

  const paths = receiver.requests.map(({ path }) => path).sort();
  assert.deepEqual(paths, ["/v1/logs", "/v1/metrics", "/v1/traces"]);
  assert.ok(receiver.requests.every(({ authorization }) => authorization === "Bearer synthetic-otlp-token"));
  assert.ok(receiver.requests.every(({ body }) => !body.includes("synthetic-otlp-token")));

  await client.close();
  await stopTelemetry();
  await receiver.close();
});

async function verifyStdioShutdown(stopChild) {
  const receiver = await startReceiver();
  try {
    const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20synthetic-otlp-token",
      OTEL_EXPORTER_OTLP_TIMEOUT: "2000",
    },
  });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`stdio runtime did not start: ${stderr}`)), 5_000);
      child.stderr.on("data", () => {
        if (stderr.includes("running on stdio")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    stopChild(child);
    const [code, signal] = await once(child, "exit");

    assert.equal(code, 0, `unexpected signal=${signal}: ${stderr}`);
    assert.equal(stdout, "", "telemetry shutdown must never corrupt JSON-RPC stdout");
    assert.doesNotMatch(stderr, /synthetic-otlp-token/);
    const paths = receiver.requests.map(({ path }) => path);
    assert.ok(paths.includes("/v1/traces"), "shutdown must flush the batched startup span");
    assert.ok(paths.includes("/v1/logs"), "shutdown must flush the batched startup log");
    assert.ok(receiver.requests.every(({ body }) => !body.includes("synthetic-otlp-token")));
  } finally {
    await receiver.close();
  }
}

test("stdio SIGTERM flushes startup telemetry without corrupting JSON-RPC stdout", async () => {
  await verifyStdioShutdown((child) => child.kill("SIGTERM"));
});

test("stdio transport close flushes startup telemetry without keeping the process alive", async () => {
  await verifyStdioShutdown((child) => child.stdin.end());
});
