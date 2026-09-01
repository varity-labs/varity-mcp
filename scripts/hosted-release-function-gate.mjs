#!/usr/bin/env node

const DEFAULT_ENDPOINT = "https://mcp.varity.so/mcp";
const PROTOCOL_VERSION = "2025-06-18";
const READ_TOOL = "varity_deploy_status";
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

  await assertAnonymousRejection(endpoint);
  console.log("  ✓ anonymous initialize rejected");

  const initialized = await protocolRequest(endpoint, token, {
    stage: "authenticated initialize",
    body: initializeRequest(2),
    expectedId: 2,
  });
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
    if (!Array.isArray(availableTools) || !availableTools.some((tool) => tool?.name === READ_TOOL)) {
      throw new GateFailure("tools/list", READ_TOOL + " is not registered");
    }
    console.log("  ✓ session continuation and tools/list expose " + READ_TOOL);

    const read = await protocolRequest(endpoint, token, {
      stage: "bounded authorized read",
      sessionId,
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: READ_TOOL, arguments: { limit: 1 } },
      },
      expectedId: 4,
    });
    if (read.payload.result.isError === true) {
      throw new GateFailure("bounded authorized read", READ_TOOL + " returned an MCP error result");
    }
    console.log("  ✓ bounded authorized " + READ_TOOL + " read succeeded");
  } finally {
    await closeSession(endpoint, token, sessionId);
  }
}

if (import.meta.url === "file://" + process.argv[1]) {
  console.log("hosted-mcp-release-function-gate:");
  runHostedReleaseFunctionGate().then(
    () => console.log("hosted-mcp-release-function-gate: passed"),
    (error) => {
      const message = error instanceof GateFailure ? error.message : "unexpected internal failure";
      console.error("hosted-mcp-release-function-gate: FAILED — " + message);
      process.exitCode = 1;
    },
  );
}
