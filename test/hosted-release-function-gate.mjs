import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const gateScript = new URL("../scripts/hosted-release-function-gate.mjs", import.meta.url);
const token = "opaque-test-token-never-print";
const expectedVersion = "9.8.7";

async function runGate(handler) {
  const requests = [];
  const receiptRoot = mkdtempSync(path.join(tmpdir(), "varity-hosted-gate-receipt-"));
  const receiptPath = path.join(receiptRoot, "gate.receipt.json");
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
      VARITY_MCP_EXPECTED_VERSION: expectedVersion,
      VARITY_MCP_RECEIPT_PATH: receiptPath,
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
  const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : undefined;
  rmSync(receiptRoot, { recursive: true, force: true });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    requests,
    receipt,
  };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function successfulHandler({ request, response, body }) {
  if (request.method === "GET" && request.url === "/health") {
    return json(response, 200, { status: "ok", version: expectedVersion, transport: "http" });
  }
  if (!request.headers.authorization) return json(response, 401, { error: "invalid_token" });
  if (body?.method === "initialize") {
    return json(response, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "varity", version: expectedVersion },
      },
    }, { "Mcp-Session-Id": "opaque-session" });
  }
  if (body?.method === "notifications/initialized") return json(response, 202);
  if (body?.method === "tools/list") {
    return json(response, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: [{ name: "varity_search_docs" }] },
    });
  }
  if (body?.method === "tools/call") {
    return json(response, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            data: {
              results: [{ title: "Deploy", url: "https://docs.varity.so", content: "Deploy an application." }],
              query: "deploy",
              totalResults: 1,
              docsUrl: "https://docs.varity.so",
            },
            message: "Found 1 result(s) for deploy",
          }),
        }],
      },
    });
  }
  if (request.method === "DELETE") return json(response, 204);
  return json(response, 500, { error: "unexpected" });
}

test("hosted gate proves exact release, rejection, session continuity, and tools/list", async () => {
  const result = await runGate(successfulHandler);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /hosted-mcp-release-function-gate: passed/);
  assert.deepEqual(result.receipt, {
    version: expectedVersion,
    serverInfoVersion: expectedVersion,
    anonymous: "rejected",
    tools: ["varity_search_docs"],
    toolsCall: {
      name: "varity_search_docs",
      query: "deploy",
      maxResults: 1,
      result: "bounded-public-docs-pass",
      docsUrl: "https://docs.varity.so",
      resultCount: 1,
    },
  });
  assert.deepEqual(result.requests[0], {
    method: "GET",
    authorization: undefined,
    sessionId: undefined,
    body: undefined,
  });
  assert.equal(result.requests[1].authorization, undefined);
  assert(result.requests.slice(2).every((request) => request.authorization === "Bearer " + token));
  assert(result.requests.slice(3).every((request) => request.sessionId === "opaque-session"));
  const toolCall = result.requests.find((request) => request.body?.method === "tools/call");
  assert.deepEqual(toolCall?.body?.params, {
    name: "varity_search_docs",
    arguments: { query: "deploy", maxResults: 1 },
  });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  assert.doesNotMatch(result.stdout + result.stderr, /opaque-session/);
});

test("hosted gate fails closed when HTTP exposes an extra tool", async () => {
  const result = await runGate(({ request, response, body }) => {
    if (request.method === "GET") {
      return json(response, 200, { status: "ok", version: expectedVersion, transport: "http" });
    }
    if (!request.headers.authorization) return json(response, 401, { error: "invalid_token" });
    if (body?.method === "initialize") {
      return json(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "varity", version: expectedVersion },
        },
      }, { "Mcp-Session-Id": "opaque-session" });
    }
    if (body?.method === "notifications/initialized") return json(response, 202);
    if (body?.method === "tools/list") {
      return json(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "varity_search_docs" }, { name: "varity_deploy_status" }] },
      });
    }
    if (request.method === "DELETE") return json(response, 204);
    return json(response, 500, { error: "unexpected" });
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /tools\/list: hosted HTTP tool allowlist differs/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("hosted gate fails closed when the advertised documentation function is broken", async () => {
  const result = await runGate(({ request, response, body }) => {
    if (request.method === "GET") {
      return json(response, 200, { status: "ok", version: expectedVersion, transport: "http" });
    }
    if (!request.headers.authorization) return json(response, 401, { error: "invalid_token" });
    if (body?.method === "initialize") {
      return json(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "varity", version: expectedVersion } },
      }, { "Mcp-Session-Id": "opaque-session" });
    }
    if (body?.method === "notifications/initialized") return json(response, 202);
    if (body?.method === "tools/list") {
      return json(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "varity_search_docs" }] },
      });
    }
    if (body?.method === "tools/call") {
      return json(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { results: [] } }) }] },
      });
    }
    if (request.method === "DELETE") return json(response, 204);
    return json(response, 500, { error: "unexpected" });
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /tools\/call: documentation search did not return one bounded public result/);
  assert(result.requests.some((request) => request.body?.method === "tools/call"));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("hosted gate fails closed when the release identity differs", async () => {
  const result = await runGate(({ request, response }) => {
    if (request.method === "GET") {
      return json(response, 200, { status: "ok", version: "9.8.6", transport: "http" });
    }
    return json(response, 500, { error: "unexpected" });
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /release identity: health does not identify exact expected HTTP release 9.8.7/);
  assert.equal(result.requests.length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("hosted gate fails closed when anonymous initialize is accepted", async () => {
  const result = await runGate(({ request, response, body }) => {
    if (request.method === "GET") {
      return json(response, 200, { status: "ok", version: expectedVersion, transport: "http" });
    }
    json(response, 200, { jsonrpc: "2.0", id: body?.id, result: {} });
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /anonymous rejection: expected HTTP 401 or 403, received 200/);
  assert.equal(result.requests.length, 2, "authorized protocol requests must not run after an anonymous false-green");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("hosted gate never prints an access token or an untrusted response body", async () => {
  const result = await runGate(({ request, response, body }) => {
    if (request.method === "GET") {
      return json(response, 200, { status: "ok", version: expectedVersion, transport: "http" });
    }
    if (!request.headers.authorization) return json(response, 401, { error: "unauthorized" });
    json(response, 500, { error: token, body, session: "sensitive-session" });
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /authenticated initialize: unexpected HTTP 500/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  assert.doesNotMatch(result.stdout + result.stderr, /sensitive-session/);
});
