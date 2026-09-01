#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const DEFAULT_ENDPOINT = "https://mcp.varity.so/mcp";
const PROTOCOL_VERSION = "2025-06-18";
const PUBLIC_READ_TOOL = "varity_search_docs";
const PUBLIC_DOCS_URL = "https://docs.varity.so";
const REQUEST_TIMEOUT_MS = 25_000;

class GateFailure extends Error {
  constructor(stage, reason) {
    super(stage + ": " + reason);
    this.name = "GateFailure";
  }
}

function endpointFromEnvironment() {
  const value = process.env.VARITY_MCP_URL ?? DEFAULT_ENDPOINT;
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new GateFailure("configuration", "VARITY_MCP_URL is not a valid URL");
  }
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
    throw new GateFailure("configuration", "the MCP endpoint must use HTTPS");
  }
  return endpoint;
}

function accessTokenFromEnvironment() {
  const token = process.env.VARITY_MCP_ACCESS_TOKEN;
  if (!token) {
    throw new GateFailure("configuration", "VARITY_MCP_ACCESS_TOKEN is required");
  }
  return token;
}

function expectedReleaseFromEnvironment() {
  const version = process.env.VARITY_MCP_EXPECTED_VERSION;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new GateFailure("configuration", "VARITY_MCP_EXPECTED_VERSION must be an exact semantic version");
  }
  return version;
}

async function assertExactRelease(endpoint, expectedVersion) {
  const healthEndpoint = new URL("/health", endpoint);
  let response;
  try {
    response = await fetch(healthEndpoint, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GateFailure("release identity", "health request failed or timed out");
  }
  if (response.status !== 200) {
    throw new GateFailure("release identity", "health returned unexpected HTTP " + response.status);
  }
  let health;
  try {
    health = await response.json();
  } catch {
    throw new GateFailure("release identity", "health did not return JSON");
  }
  if (health?.status !== "ok" || health?.transport !== "http" || health?.version !== expectedVersion) {
    throw new GateFailure("release identity", "health does not identify exact expected HTTP release " + expectedVersion);
  }
  return health;
}

function parseRpcPayload(text, expectedId, stage) {
  const candidates = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const data = line.slice("data:".length).trim();
      if (data && data !== "[DONE]") candidates.push(data);
    }
  }

  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate);
      if (payload?.id === expectedId) return payload;
    } catch {
      // A response body is untrusted and may contain protected data. Never echo it.
    }
  }
  throw new GateFailure(stage, "response did not contain the expected JSON-RPC result");
}

async function protocolRequest(endpoint, token, { stage, body, sessionId, expectedId, acceptedStatuses = [200] }) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Authorization: "Bearer " + token,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GateFailure(stage, "request failed or timed out");
  }

  if (!acceptedStatuses.includes(response.status)) {
    throw new GateFailure(stage, "unexpected HTTP " + response.status);
  }
  if (expectedId === undefined) return { response };

  const text = await response.text();
  const payload = parseRpcPayload(text, expectedId, stage);
  if (payload.error) throw new GateFailure(stage, "server returned a JSON-RPC error");
  if (!payload.result) throw new GateFailure(stage, "server returned no JSON-RPC result");
  return { response, payload };
}

async function assertAnonymousRejection(endpoint) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initializeRequest(1)),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GateFailure("anonymous rejection", "request failed or timed out");
  }
  if (response.status !== 401 && response.status !== 403) {
    throw new GateFailure("anonymous rejection", "expected HTTP 401 or 403, received " + response.status);
  }
}

function initializeRequest(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "varity-hosted-release-function-gate", version: "1.0.0" },
    },
  };
}

function assertPublicDocsResult(payload) {
  const content = payload?.result?.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") {
    throw new GateFailure("tools/call", "documentation search returned an unexpected MCP result shape");
  }
  if (typeof content[0].text !== "string" || content[0].text.length > 5_000) {
    throw new GateFailure("tools/call", "documentation search result is absent or exceeds the public-result bound");
  }

  let projection;
  try {
    projection = JSON.parse(content[0].text);
  } catch {
    throw new GateFailure("tools/call", "documentation search result is not structured JSON");
  }
  const results = projection?.data?.results;
  if (
    projection?.success !== true ||
    projection?.data?.docsUrl !== PUBLIC_DOCS_URL ||
    projection?.data?.query !== "deploy" ||
    !Array.isArray(results) ||
    results.length !== 1
  ) {
    throw new GateFailure("tools/call", "documentation search did not return one bounded public result");
  }
  const result = results[0];
  if (
    typeof result?.title !== "string" || result.title.length === 0 || result.title.length > 256 ||
    result?.url !== PUBLIC_DOCS_URL ||
    typeof result?.content !== "string" || result.content.length === 0 || result.content.length > 1_200
  ) {
    throw new GateFailure("tools/call", "documentation search returned an invalid public result");
  }
  return { docsUrl: projection.data.docsUrl, resultCount: results.length };
}

async function closeSession(endpoint, token, sessionId) {
  try {
    await fetch(endpoint, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + token, "Mcp-Session-Id": sessionId },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Cleanup is best-effort; the bounded function proof has already completed.
  }
}

export async function runHostedReleaseFunctionGate() {
  const endpoint = endpointFromEnvironment();
  const token = accessTokenFromEnvironment();
  const expectedVersion = expectedReleaseFromEnvironment();

  const health = await assertExactRelease(endpoint, expectedVersion);
  console.log("  ✓ exact HTTP release " + expectedVersion + " identified");

  await assertAnonymousRejection(endpoint);
  console.log("  ✓ anonymous initialize rejected");

  const initialized = await protocolRequest(endpoint, token, {
    stage: "authenticated initialize",
    body: initializeRequest(2),
    expectedId: 2,
  });
  if (initialized.payload.result.serverInfo?.version !== expectedVersion) {
    throw new GateFailure("authenticated initialize", "serverInfo.version does not match exact expected release " + expectedVersion);
  }
  const sessionId = initialized.response.headers.get("mcp-session-id");
  if (!sessionId) throw new GateFailure("authenticated initialize", "Mcp-Session-Id header is missing");
  console.log("  ✓ authenticated initialize created an opaque session");

  try {
    await protocolRequest(endpoint, token, {
      stage: "session continuation",
      sessionId,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      acceptedStatuses: [200, 202, 204],
    });

    const tools = await protocolRequest(endpoint, token, {
      stage: "tools/list",
      sessionId,
      body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      expectedId: 3,
    });
    const availableTools = tools.payload.result.tools;
    const toolNames = Array.isArray(availableTools)
      ? availableTools.map((tool) => tool?.name).sort()
      : [];
    if (toolNames.length !== 1 || toolNames[0] !== PUBLIC_READ_TOOL) {
      throw new GateFailure("tools/list", "hosted HTTP tool allowlist differs from " + PUBLIC_READ_TOOL);
    }
    console.log("  ✓ authenticated session continuity and exact public-read tool allowlist");

    const called = await protocolRequest(endpoint, token, {
      stage: "tools/call",
      sessionId,
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: PUBLIC_READ_TOOL, arguments: { query: "deploy", maxResults: 1 } },
      },
      expectedId: 4,
    });
    const docsResult = assertPublicDocsResult(called.payload);
    console.log("  ✓ public documentation search returned one bounded result");
    return {
      version: health.version,
      serverInfoVersion: initialized.payload.result.serverInfo.version,
      anonymous: "rejected",
      tools: toolNames,
      toolsCall: {
        name: PUBLIC_READ_TOOL,
        query: "deploy",
        maxResults: 1,
        result: "bounded-public-docs-pass",
        docsUrl: docsResult.docsUrl,
        resultCount: docsResult.resultCount,
      },
    };
  } finally {
    await closeSession(endpoint, token, sessionId);
  }
}

if (import.meta.url === "file://" + process.argv[1]) {
  console.log("hosted-mcp-release-function-gate:");
  runHostedReleaseFunctionGate().then(
    (receipt) => {
      const receiptPath = process.env.VARITY_MCP_RECEIPT_PATH;
      if (receiptPath) writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      console.log("hosted-mcp-release-function-gate: passed");
    },
    (error) => {
      const message = error instanceof GateFailure ? error.message : "unexpected internal failure";
      console.error("hosted-mcp-release-function-gate: FAILED — " + message);
      process.exitCode = 1;
    },
  );
}
