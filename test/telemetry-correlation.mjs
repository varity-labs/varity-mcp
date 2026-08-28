import assert from "node:assert/strict";
import { test } from "node:test";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const {
  failureAttributes,
  flushTelemetry,
  instrumentMcpServer,
  sanitizeSentryEvent,
  startTelemetry,
  stopTelemetry,
} = await import("../dist/telemetry.js");

test("MCP operation spans, logs, and metrics correlate without capturing protected inputs", async () => {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const protectedValue = "synthetic-secret-value-never-export";
  const parentTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  assert.equal(startTelemetry({
    version: "test",
    transport: "stdio",
    exporters: { spans, logs, metrics },
  }), true);

  const server = new McpServer({ name: "telemetry-test", version: "1.0.0" });
  instrumentMcpServer(server, "stdio");
  server.registerTool("safe_tool", { description: "Test tool" }, async () => ({
    content: [{ type: "text", text: protectedValue }],
  }));

  const client = new Client({ name: "telemetry-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.callTool({
    name: "safe_tool",
    arguments: { credential: protectedValue },
    _meta: {
      traceparent: `00-${parentTraceId}-00f067aa0ba902b7-01`,
      baggage: `credential=${protectedValue}`,
    },
  });
  const unknownTool = await client.callTool({
    name: "not_registered",
    arguments: { credential: protectedValue },
  });
  assert.equal(unknownTool.isError, true, "unknown tools use an MCP error result, not a transport rejection");
  await flushTelemetry();

  const operation = spans.getFinishedSpans().find((span) => span.name === "tools/call safe_tool");
  assert.ok(operation, "the real MCP tools/call handler must emit a span");
  assert.equal(operation.kind, 1, "MCP server operations use SERVER span kind");
  assert.equal(operation.spanContext().traceId, parentTraceId, "MCP traceparent must become the server span parent");
  assert.equal(operation.attributes["mcp.method.name"], "tools/call");
  assert.equal(operation.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(operation.attributes["gen_ai.tool.name"], "safe_tool");
  assert.equal(operation.attributes["network.transport"], "pipe");
  assert.equal(operation.attributes["jsonrpc.request.id"], undefined);
  assert.equal(operation.attributes["mcp.session.id"], undefined);

  const failedOperation = spans.getFinishedSpans().find((span) =>
    span.name === "tools/call" && span.status.code === 2);
  assert.ok(failedOperation, "an unknown tool must emit a failed MCP operation span");
  assert.ok(failedOperation.attributes["error.type"]);

  const correlatedLog = logs.getFinishedLogRecords().find((record) =>
    record.attributes["mcp.method.name"] === "tools/call");
  assert.ok(correlatedLog, "the MCP completion log must be exported");
  assert.equal(correlatedLog.spanContext?.traceId, operation.spanContext().traceId);
  assert.equal(correlatedLog.spanContext?.spanId, operation.spanContext().spanId);
  const failureLog = logs.getFinishedLogRecords().find((record) =>
    record.attributes.diagnostic_code === "mcp_result_error" &&
    record.spanContext?.spanId === failedOperation.spanContext().spanId);
  assert.ok(failureLog);
  assert.equal(failureLog.attributes.action, "inspect_correlated_trace_and_result_before_retry");
  assert.equal(failureLog.attributes["mcp.method.name"], "tools/call");
  assert.equal(failureLog.attributes.lifecycle_stage, "mcp_handler");
  assert.equal(failureLog.attributes.failure_cause, "unobserved");
  assert.equal(failureLog.attributes.failure_domain, "unobserved");
  assert.equal(failureLog.attributes.owner_id, "unobserved");
  assert.equal(failureLog.attributes.retryable, "unobserved");
  assert.equal(failedOperation.attributes["gen_ai.tool.name"], undefined,
    "an attacker-controlled unknown tool name must not become a dimension");

  const metricNames = metrics.getMetrics().flatMap((resource) =>
    resource.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)));
  assert.ok(metricNames.includes("mcp.server.operation.duration"));

  const exported = JSON.stringify({
    spans: spans.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes })),
    logs: logs.getFinishedLogRecords().map((record) => ({ body: record.body, attributes: record.attributes })),
    metricNames,
  });
  assert.doesNotMatch(exported, new RegExp(protectedValue));
  assert.doesNotMatch(exported, /credential/i);

  await client.close();
  await stopTelemetry();
});

test("error-only telemetry wraps MCP handlers and captures failure results without OTLP", async () => {
  const captured = [];
  let shutdownCalled = false;
  const errorSink = {
    capture(error, attributes, spanContext) {
      captured.push({ error, attributes, spanContext });
    },
    async flush() {},
    async shutdown() { shutdownCalled = true; },
  };
  assert.equal(startTelemetry({ version: "test", transport: "stdio", errorSink }), true);

  const server = new McpServer({ name: "error-only-test", version: "1.0.0" });
  instrumentMcpServer(server, "stdio");
  server.registerTool("known_tool", { description: "Known test tool" }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const client = new Client({ name: "error-only-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name: "unknown_tool", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(captured.length, 1, "the error sink must remain independent of OTLP tracing");
  assert.equal(captured[0].attributes["mcp.method.name"], "tools/call");
  assert.equal(captured[0].attributes.action, "inspect_correlated_trace_and_result_before_retry");
  assert.equal(captured[0].attributes.diagnostic_code, "mcp_result_error");
  assert.equal(captured[0].attributes.lifecycle_stage, "mcp_handler");
  if (captured[0].spanContext) {
    assert.match(captured[0].spanContext.traceId, /^[a-f0-9]{32}$/,
      "an ambient global trace must remain valid correlation, never a synthetic identifier");
    assert.match(captured[0].spanContext.spanId, /^[a-f0-9]{16}$/);
  }

  await client.close();
  await stopTelemetry();
  assert.equal(shutdownCalled, true);
});

function wrappedHandler(handler) {
  let registered;
  const protocol = {
    setRequestHandler(_schema, next) {
      registered = next;
    },
  };
  instrumentMcpServer({ server: protocol }, "stdio");
  protocol.setRequestHandler({}, handler);
  assert.ok(registered);
  return registered;
}

function captureThrowingSink(canary) {
  return {
    capture() { throw new Error(canary); },
    async flush() {},
    async shutdown() {},
  };
}

async function withoutDiagnosticOutput(run) {
  const diagnostics = [];
  const originalConsoleError = console.error;
  console.error = (value) => diagnostics.push(String(value));
  try {
    await run();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(JSON.parse(diagnostics.at(-1)).message,
    "Error telemetry capture failed; runtime continuing");
  return diagnostics;
}

test("a throwing error sink cannot replace an MCP error result", async () => {
  const canary = "capture-sink-result-canary";
  assert.equal(startTelemetry({
    version: "test",
    transport: "stdio",
    errorSink: captureThrowingSink(canary),
  }), true);
  const result = { isError: true, content: [{ type: "text", text: "original result" }] };
  const handler = wrappedHandler(async () => result);

  const diagnostics = await withoutDiagnosticOutput(async () => {
    assert.strictEqual(await handler({ method: "tools/call" }, {}), result);
  });
  assert.doesNotMatch(diagnostics.join("\n"), new RegExp(canary));
  await stopTelemetry();
});

test("a throwing error sink cannot replace a handler exception", async () => {
  const canary = "capture-sink-exception-canary";
  assert.equal(startTelemetry({
    version: "test",
    transport: "stdio",
    errorSink: captureThrowingSink(canary),
  }), true);
  const original = new Error("original handler failure");
  const handler = wrappedHandler(async () => { throw original; });

  const diagnostics = await withoutDiagnosticOutput(async () => {
    await assert.rejects(() => handler({ method: "tools/call" }, {}), (error) => error === original);
  });
  assert.doesNotMatch(diagnostics.join("\n"), new RegExp(canary));
  await stopTelemetry();
});

test("failure projection records only the four bounded observed lifecycle stages", () => {
  const stages = ["mcp_handler", "http_request", "runtime_start", "runtime_shutdown"];
  for (const stage of stages) {
    const attributes = failureAttributes("inspect_correlated_trace_before_retry", "synthetic_failure", stage);
    assert.equal(attributes.lifecycle_stage, stage);
    assert.equal(attributes.action, "inspect_correlated_trace_before_retry");
    assert.equal(attributes.failure_cause, "unobserved");
    assert.equal(attributes.failure_domain, "unobserved");
    assert.equal(attributes.owner_id, "unobserved");
    assert.equal(attributes.retryable, "unobserved");
  }
});

test("Sentry structural allowlist removes arbitrary exception, stack, and context data", () => {
  const canary = "customer-secret-canary";
  const safe = sanitizeSentryEvent({
    type: undefined,
    message: canary,
    logentry: { message: canary, params: [canary] },
    request: { url: `https://example.invalid/${canary}`, headers: { authorization: canary } },
    user: { id: canary },
    extra: { canary },
    breadcrumbs: [{ message: canary }],
    threads: { values: [{ id: 1, name: canary }] },
    contexts: {
      otel: {
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        span_id: "00f067aa0ba902b7",
      },
      unsafe: { canary },
    },
    tags: {
      action: "inspect_correlated_trace_and_result_before_retry",
      failure_domain: "unobserved",
      unsafe: canary,
    },
    exception: {
      values: [{
        type: "TypeError",
        value: canary,
        mechanism: { type: canary },
        stacktrace: {
          frames: [{
            filename: `/private/${canary}/project.ts`,
            function: canary,
            lineno: 42,
            colno: 7,
            context_line: canary,
            pre_context: [canary],
            post_context: [canary],
            vars: { canary },
            in_app: true,
          }],
        },
      }],
    },
  });

  assert.doesNotMatch(JSON.stringify(safe), new RegExp(canary));
  assert.equal(safe.exception.values[0].type, "TypeError");
  assert.equal(safe.exception.values[0].value, "MCP runtime operation failed");
  assert.deepEqual(safe.exception.values[0].stacktrace.frames[0], {
    filename: "[application]",
    lineno: 42,
    colno: 7,
    in_app: true,
  });
  assert.equal(safe.contexts.otel.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(safe.tags.action, "inspect_correlated_trace_and_result_before_retry");
  assert.equal(safe.tags.unsafe, undefined);
});
