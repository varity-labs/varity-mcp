import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

const gateScript = new URL("../scripts/hosted-release-function-gate.mjs", import.meta.url);
const token = "opaque-test-token-never-print";

async function runGate(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
      sessionId: request.headers["mcp-session-id"],
      body,
    });
    handler({ request, response, body });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  const child = spawn(process.execPath, [gateScript.pathname], {
    env: {
      ...process.env,
      VARITY_MCP_URL: "http://127.0.0.1:" + address.port + "/mcp",
      VARITY_MCP_ACCESS_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [exitCode] = await once(child, "exit");
  server.close();
  await once(server, "close");
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    requests,
  };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

test("hosted gate proves rejection, session continuation, tools/list, and a bounded read", async () => {
  const result = await runGate(({ request, response, body }) => {
    if (!request.headers.authorization) return json(response, 401, { error: "unauthorized" });
    if (body?.method === "initialize") {
      return json(response, 200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }, { "Mcp-Session-Id": "opaque-session" });
    }
    if (body?.method === "notifications/initialized") return json(response, 202);
    if (body?.method === "tools/list") {
      return json(response, 200, { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "varity_deploy_status" }] } });
    }
    if (body?.method === "tools/call") {
      return json(response, 200, { jsonrpc: "2.0", id: body.id, result: { isError: false, content: [] } });
    }
    if (request.method === "DELETE") return json(response, 204);
    return json(response, 500, { error: "unexpected" });
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /hosted-mcp-release-function-gate: passed/);
  assert.equal(result.requests[0].authorization, undefined);
  assert(result.requests.slice(1).every((request) => request.authorization === "Bearer " + token));
  assert(result.requests.slice(2).every((request) => request.sessionId === "opaque-session"));
  const toolCall = result.requests.find((request) => request.body?.method === "tools/call");
  assert.deepEqual(toolCall?.body.params, { name: "varity_deploy_status", arguments: { limit: 1 } });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  assert.doesNotMatch(result.stdout + result.stderr, /opaque-session/);
});

test("hosted gate fails closed when anonymous initialize is accepted", async () => {
  const result = await runGate(({ response, body }) => {
    json(response, 200, { jsonrpc: "2.0", id: body?.id, result: {} });
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /anonymous rejection: expected HTTP 401 or 403, received 200/);
  assert.equal(result.requests.length, 1, "authorized protocol requests must not run after an anonymous false-green");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("hosted gate never prints an access token or an untrusted response body", async () => {
  const result = await runGate(({ request, response, body }) => {
    if (!request.headers.authorization) return json(response, 401, { error: "unauthorized" });
    json(response, 500, { error: token, body, session: "sensitive-session" });
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /authenticated initialize: unexpected HTTP 500/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  assert.doesNotMatch(result.stdout + result.stderr, /sensitive-session/);
});
