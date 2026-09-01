import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const principalAToken = "principal-a-token-never-print";
const principalBToken = "principal-b-token-never-print";
const missingPrincipalToken = "missing-principal-token-never-print";

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
  const gateway = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/auth/verify") {
      response.writeHead(404).end();
      return;
    }
    const authorization = request.headers.authorization;
    const identity = authorization === "Bearer " + principalAToken
      ? { user_id: "principal-a", scopes: ["read"] }
      : authorization === "Bearer " + principalBToken
        ? { user_id: "principal-b", scopes: ["read"] }
        : authorization === "Bearer " + missingPrincipalToken
          ? { scopes: ["read"] }
          : undefined;
    if (!identity) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(identity));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const gatewayAddress = gateway.address();
  assert(gatewayAddress && typeof gatewayAddress === "object");

  const port = await reservePort();
  const baseUrl = "http://127.0.0.1:" + port;
  const childEnv = {
    ...process.env,
    VARITY_GATEWAY_URL: "http://127.0.0.1:" + gatewayAddress.port,
    NODE_OPTIONS: "--import=" + new URL("./fixtures/http-docs-fetch.mjs", import.meta.url).href,
  };
  delete childEnv.VARITY_MCP_DEV_TOKEN;
  const child = spawn(process.execPath, ["dist/index.js", "--transport", "http", "--port", String(port)], {
    cwd: new URL("..", import.meta.url),
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    gateway.close();
    await once(gateway, "close");
  });

  const deadline = Date.now() + 30_000;
  let health;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      health = await fetch(baseUrl + "/health");
      if (health.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert(health?.ok, Buffer.concat(stderr).toString("utf8") || "real MCP runtime did not start");

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

  const missingPrincipal = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + missingPrincipalToken,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(initializeRequest()),
  });
  assert.equal(missingPrincipal.status, 401);
  assert.equal(missingPrincipal.headers.get("mcp-session-id"), null);
  assert.deepEqual(await missingPrincipal.json(), {
    error: "invalid_token",
    error_description: "The Bearer access token is invalid or expired",
  });

  const authorization = { Authorization: "Bearer " + principalAToken };
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

  const mismatchedPrincipal = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + principalBToken,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(mismatchedPrincipal.status, 403);
  assert.deepEqual(await mismatchedPrincipal.json(), {
    error: "insufficient_scope",
    error_description: "The MCP session belongs to a different authenticated principal",
  });

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

  const called = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      ...authorization,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "varity_search_docs", arguments: { query: "deploy", maxResults: 1 } },
    }),
  });
  assert.equal(called.status, 200);
  const callPayload = await rpcResult(called, 3);
  const content = callPayload.result.content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert(content[0].text.length <= 5_000);
  const projection = JSON.parse(content[0].text);
  assert.equal(projection.success, true);
  assert.equal(projection.data.docsUrl, "https://docs.varity.so");
  assert.equal(projection.data.query, "deploy");
  assert.equal(projection.data.results.length, 1);
  assert.deepEqual(projection.data.results.map(({ title, url, content: body }) => ({
    titleBounded: typeof title === "string" && title.length > 0 && title.length <= 256,
    url,
    contentBounded: typeof body === "string" && body.length > 0 && body.length <= 1_200,
  })), [{
    titleBounded: true,
    url: "https://docs.varity.so",
    contentBounded: true,
  }]);
  for (const token of [principalAToken, principalBToken, missingPrincipalToken]) {
    assert.doesNotMatch(content[0].text, new RegExp(token));
  }

  const closed = await fetch(baseUrl + "/mcp", {
    method: "DELETE",
    headers: { ...authorization, "Mcp-Session-Id": sessionId },
  });
  assert([200, 202, 204].includes(closed.status));
  await closed.arrayBuffer();
  const diagnostics = Buffer.concat(stderr).toString("utf8");
  for (const token of [principalAToken, principalBToken, missingPrincipalToken]) {
    assert.doesNotMatch(diagnostics, new RegExp(token));
  }
});
