import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { startHttp } from "../dist/index.js";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const devToken = "real-server-contract-token-never-print";

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

function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "real-server-contract", version: "1.0.0" },
    },
  };
}

async function rpcResult(response, expectedId) {
  const text = await response.text();
  const candidates = [
    text.trim(),
    ...text.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()),
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate === "[DONE]") continue;
    try {
      const payload = JSON.parse(candidate);
      if (payload?.id === expectedId) return payload;
    } catch {
      // Continue across JSON and SSE response forms.
    }
  }
  throw new Error("expected JSON-RPC result was absent");
}

test("real HTTP server rejects anonymous initialize and preserves an authenticated session", async (t) => {
  const port = await reservePort();
  const baseUrl = "http://127.0.0.1:" + port;
  const previousDevToken = process.env.VARITY_MCP_DEV_TOKEN;
  process.env.VARITY_MCP_DEV_TOKEN = devToken;
  const shutdown = await startHttp(port);
  t.after(async () => {
    if (previousDevToken === undefined) delete process.env.VARITY_MCP_DEV_TOKEN;
    else process.env.VARITY_MCP_DEV_TOKEN = previousDevToken;
    await shutdown();
  });

  const anonymous = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(initializeRequest()),
  });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Bearer error="invalid_token"/);
  assert.equal(anonymous.headers.get("mcp-session-id"), null);
  assert.deepEqual(await anonymous.json(), {
    error: "invalid_token",
    error_description: "A valid Bearer access token is required",
  });

  const authorization = { Authorization: "Bearer " + devToken };
  const initialized = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      ...authorization,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(initializeRequest()),
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get("mcp-session-id");
  assert(sessionId);
  const initializePayload = await rpcResult(initialized, 1);
  assert.equal(initializePayload.result.serverInfo.version, version);

  const continued = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      ...authorization,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert([200, 202, 204].includes(continued.status));
  await continued.arrayBuffer();

  const listed = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      ...authorization,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(listed.status, 200);
  const toolsPayload = await rpcResult(listed, 2);
  assert.deepEqual(toolsPayload.result.tools.map((tool) => tool.name), ["varity_search_docs"]);

  const closed = await fetch(baseUrl + "/mcp", {
    method: "DELETE",
    headers: { ...authorization, "Mcp-Session-Id": sessionId },
  });
  assert([200, 202, 204].includes(closed.status));
  await closed.arrayBuffer();
});
