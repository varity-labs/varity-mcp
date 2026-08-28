import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import {
  SpanKind,
  SpanStatusCode,
  context,
  isSpanContextValid,
  propagation,
  trace,
  type Attributes,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import { SeverityNumber, type Logger as OtelLogger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TransportMode } from "./server.js";

const SERVICE_NAME = "varity-mcp";
const INSTRUMENTATION_NAME = "@varity-labs/mcp";
const SAFE_TARGET = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const TRACE_HEADERS = new Set(["traceparent", "tracestate"]);
const SENTRY_SAFE_TAGS = new Set([
  "action",
  "diagnostic_code",
  "error.type",
  "failure_cause",
  "failure_domain",
  "lifecycle_stage",
  "mcp.method.name",
  "network.transport",
  "owner_id",
  "retryable",
  "service.name",
  "so.varity.mcp.operation.name",
]);
const LOG_SEVERITIES = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

type SafeAttributeValue = string | number | boolean;
export type TelemetryAttributes = Record<string, SafeAttributeValue>;

interface McpRequest {
  method: string;
  params?: Record<string, unknown>;
}

type McpResult = Record<string, unknown>;
type McpRequestHandler = (request: McpRequest, extra: unknown) => McpResult | Promise<McpResult>;
type SetRequestHandler = (schema: unknown, handler: McpRequestHandler) => void;

/**
 * Exporter injection is the narrow verification seam. Production callers leave
 * this undefined so the official exporters read the standard OTEL_* variables.
 */
export interface TelemetryExporters {
  spans: SpanExporter;
  logs: LogRecordExporter;
  metrics: PushMetricExporter;
}

export interface ErrorTelemetrySink {
  capture(error: unknown, attributes: TelemetryAttributes, spanContext?: SpanContext): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  version: string;
  transport: TransportMode;
  exporters?: TelemetryExporters;
  errorSink?: ErrorTelemetrySink;
}

interface ActiveTelemetry {
  tracerProvider?: NodeTracerProvider;
  loggerProvider?: LoggerProvider;
  meterProvider?: MeterProvider;
  logger?: OtelLogger;
  version: string;
  errorSink?: ErrorTelemetrySink;
}

let active: ActiveTelemetry | undefined;
let shutdownPromise: Promise<void> | undefined;

function hasOtlpConfiguration(): boolean {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  );
}

function hasTraceConfiguration(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

function hasLogConfiguration(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT);
}

function hasMetricConfiguration(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
}

function reportDiagnostic(message: string): void {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "warn",
    service: SERVICE_NAME,
    message,
  }));
}

function safeErrorType(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "number" && Number.isFinite(code)) return String(code);
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) return error.name;
  return "_OTHER";
}

function safeTarget(request: McpRequest): { name?: string; attribute?: string } {
  const candidate = request.params?.name;
  if (typeof candidate !== "string" || !SAFE_TARGET.test(candidate)) return {};
  if (request.method === "tools/call") return { name: candidate, attribute: "gen_ai.tool.name" };
  if (request.method === "prompts/get") return { name: candidate, attribute: "gen_ai.prompt.name" };
  return {};
}

function requestParent(request: McpRequest): { parent: Context; links: Array<{ context: SpanContext }> } {
  const ambient = context.active();
  const meta = request.params?._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { parent: ambient, links: [] };

  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (TRACE_HEADERS.has(key.toLowerCase()) && typeof value === "string") carrier[key] = value;
  }
  const extracted = propagation.extract(ambient, carrier);
  const extractedSpan = trace.getSpanContext(extracted);
  if (!extractedSpan || !isSpanContextValid(extractedSpan)) return { parent: ambient, links: [] };

  const ambientSpan = trace.getSpanContext(ambient);
  const links = ambientSpan && isSpanContextValid(ambientSpan) && ambientSpan.traceId !== extractedSpan.traceId
    ? [{ context: ambientSpan }]
    : [];
  return { parent: extracted, links };
}

function mcpAttributes(method: string, transport: TransportMode): Attributes {
  return {
    "mcp.method.name": method,
    "network.transport": transport === "stdio" ? "pipe" : "tcp",
    ...(transport === "http" ? { "network.protocol.name": "http" } : {}),
    ...(method === "tools/call" ? { "gen_ai.operation.name": "execute_tool" } : {}),
  };
}

function telemetryLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  attributes: TelemetryAttributes = {}
): void {
  const logger = active?.logger;
  if (!logger) return;
  logger.emit({
    severityNumber: LOG_SEVERITIES[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes,
    context: context.active(),
  });
}

function safeEventValue(value: string | undefined, maxLength = 128): string | undefined {
  return value && /^[A-Za-z0-9_.@:/-]+$/.test(value) ? value.slice(0, maxLength) : undefined;
}

/** Structural allowlist used by the production error adapter and its canary test. */
export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent {
  const otel = event.contexts?.otel;
  const traceId = typeof otel?.trace_id === "string" && /^[a-f0-9]{32}$/.test(otel.trace_id)
    ? otel.trace_id
    : undefined;
  const spanId = typeof otel?.span_id === "string" && /^[a-f0-9]{16}$/.test(otel.span_id)
    ? otel.span_id
    : undefined;
  const tags: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event.tags ?? {})) {
    if (!SENTRY_SAFE_TAGS.has(key)) continue;
    if (typeof value === "boolean" || typeof value === "number") {
      tags[key] = value;
      continue;
    }
    const safe = safeEventValue(typeof value === "string" ? value : undefined);
    if (safe) tags[key] = safe;
  }
  const exceptions = event.exception?.values?.slice(0, 4).map((exception) => ({
    type: safeEventValue(exception.type, 80) ?? "Error",
    value: "MCP runtime operation failed",
    stacktrace: exception.stacktrace?.frames
      ? {
          frames: exception.stacktrace.frames.slice(-64).map((frame) => ({
            filename: frame.in_app === false ? "[dependency]" : "[application]",
            ...(Number.isInteger(frame.lineno) ? { lineno: frame.lineno } : {}),
            ...(Number.isInteger(frame.colno) ? { colno: frame.colno } : {}),
            ...(typeof frame.in_app === "boolean" ? { in_app: frame.in_app } : {}),
          })),
        }
      : undefined,
  }));

  return {
    type: undefined,
    event_id: safeEventValue(event.event_id, 32),
    timestamp: event.timestamp,
    level: event.level,
    platform: safeEventValue(event.platform),
    release: safeEventValue(event.release),
    environment: safeEventValue(event.environment),
    exception: exceptions ? { values: exceptions } : undefined,
    contexts: traceId && spanId ? { otel: { trace_id: traceId, span_id: spanId } } : undefined,
    tags: Object.keys(tags).length > 0 ? tags : undefined,
  };
}

function startSentry(version: string): ErrorTelemetrySink | undefined {
  const dsn = process.env.BETTERSTACK_MCP_DSN;
  if (!dsn) return undefined;
  try {
    Sentry.initWithoutDefaultIntegrations({
      dsn,
      release: `${SERVICE_NAME}@${version}`,
      environment: process.env.NODE_ENV ?? "development",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSend: sanitizeSentryEvent,
    });
    return {
      capture(error, attributes, spanContext): void {
        Sentry.withScope((scope) => {
          scope.setTags({ "service.name": SERVICE_NAME, ...attributes });
          if (spanContext && isSpanContextValid(spanContext)) {
            scope.setContext("otel", { trace_id: spanContext.traceId, span_id: spanContext.spanId });
          }
          Sentry.captureException(error);
        });
      },
      async flush(): Promise<void> {
        await Sentry.flush(5_000);
      },
      async shutdown(): Promise<void> {
        await Sentry.close(5_000);
      },
    };
  } catch {
    reportDiagnostic("Error telemetry initialization failed; runtime continuing without error export");
    return undefined;
  }
}

export function startTelemetry(options: TelemetryOptions): boolean {
  if (active) return true;
  shutdownPromise = undefined;
  const exporters = options.exporters;
  const otlpConfigured = exporters !== undefined || hasOtlpConfiguration();
  const errorSink = options.errorSink ?? startSentry(options.version);
  if (!otlpConfigured && !errorSink) return false;

  const resource = resourceFromAttributes({
    "service.name": SERVICE_NAME,
    "service.version": options.version,
    "service.namespace": "varity",
    "deployment.environment.name": process.env.NODE_ENV ?? "development",
  });

  let tracerProvider: NodeTracerProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  let meterProvider: MeterProvider | undefined;
  try {
    const traceEnabled = exporters !== undefined || hasTraceConfiguration();
    const logsEnabled = exporters !== undefined || hasLogConfiguration();
    const metricsEnabled = exporters !== undefined || hasMetricConfiguration();
    tracerProvider = traceEnabled
      ? new NodeTracerProvider({
          resource,
          spanProcessors: [exporters
            ? new SimpleSpanProcessor(exporters.spans)
            : new BatchSpanProcessor(new OTLPTraceExporter())],
        })
      : undefined;
    loggerProvider = logsEnabled
      ? new LoggerProvider({
          resource,
          processors: [exporters
            ? new SimpleLogRecordProcessor({ exporter: exporters.logs })
            : new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
        })
      : undefined;
    const metricReader = metricsEnabled
      ? new PeriodicExportingMetricReader({
          exporter: exporters?.metrics ?? new OTLPMetricExporter(),
          exportIntervalMillis: 30_000,
          exportTimeoutMillis: 10_000,
          cardinalityLimits: { default: 128 },
        })
      : undefined;
    meterProvider = metricReader ? new MeterProvider({ resource, readers: [metricReader] }) : undefined;
    // Register only after every configured adapter constructed successfully so
    // a later constructor failure cannot strand a partial global provider.
    tracerProvider?.register();
    active = {
      tracerProvider,
      loggerProvider,
      meterProvider,
      logger: loggerProvider?.getLogger(INSTRUMENTATION_NAME, options.version),
      version: options.version,
      errorSink,
    };

    const tracer = tracerProvider?.getTracer(INSTRUMENTATION_NAME, options.version);
    if (tracer) {
      tracer.startActiveSpan("service.startup", {
        kind: SpanKind.INTERNAL,
        attributes: { "network.transport": options.transport === "stdio" ? "pipe" : "tcp" },
      }, (span) => {
        telemetryLog("info", "MCP telemetry initialized", {
          "network.transport": options.transport === "stdio" ? "pipe" : "tcp",
        });
        span.end();
      });
    } else {
      telemetryLog("info", "MCP telemetry initialized", {
        "network.transport": options.transport === "stdio" ? "pipe" : "tcp",
      });
    }
    return true;
  } catch {
    active = errorSink ? { version: options.version, errorSink } : undefined;
    void Promise.allSettled([
      tracerProvider?.shutdown(),
      loggerProvider?.shutdown(),
      meterProvider?.shutdown(),
    ]);
    reportDiagnostic("Telemetry initialization failed; runtime continuing without OTLP export");
    return Boolean(errorSink);
  }
}

export function instrumentMcpServer(server: McpServer, transport: TransportMode): void {
  if (!active) return;
  const protocol = server.server as typeof server.server & { setRequestHandler: SetRequestHandler };
  const original = protocol.setRequestHandler.bind(protocol) as SetRequestHandler;
  const tracer = active.tracerProvider?.getTracer(INSTRUMENTATION_NAME, active.version)
    ?? trace.getTracer(INSTRUMENTATION_NAME, active.version);
  const duration = active.meterProvider?.getMeter(INSTRUMENTATION_NAME, active.version)
    .createHistogram("mcp.server.operation.duration", {
      description: "Duration of MCP server operations",
      unit: "s",
    });

  protocol.setRequestHandler = ((schema: unknown, handler: McpRequestHandler): void => {
    original(schema, async (request, extra) => {
      const method = request.method;
      const startedAt = process.hrtime.bigint();
      const parent = requestParent(request);
      const baseAttributes = mcpAttributes(method, transport);
      return tracer.startActiveSpan(method, {
        kind: SpanKind.SERVER,
        attributes: baseAttributes,
        links: parent.links,
      }, parent.parent, async (span) => {
        let metricAttributes: Attributes = { ...baseAttributes };
        try {
          const result = await handler(request, extra);
          const target = result.isError === true ? {} : safeTarget(request);
          if (target.name && target.attribute) {
            span.setAttribute(target.attribute, target.name);
            span.updateName(`${method} ${target.name}`);
            metricAttributes = { ...metricAttributes, [target.attribute]: target.name };
          }
          if (result.isError === true) {
            const failure = failureAttributes(
              "inspect_correlated_trace_and_result_before_retry",
              "mcp_result_error",
              "mcp_handler"
            );
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute("error.type", "_OTHER");
            metricAttributes = { ...metricAttributes, "error.type": "_OTHER" };
            telemetryLog("error", "MCP operation completed with an error result", {
              ...metricAttributes,
              ...failure,
            } as TelemetryAttributes);
            captureTelemetryException(new Error("MCP operation returned an error result"), {
              ...failure,
              "mcp.method.name": method,
              "network.transport": transport === "stdio" ? "pipe" : "tcp",
              "error.type": "_OTHER",
            });
          } else {
            telemetryLog("info", "MCP operation completed", metricAttributes as TelemetryAttributes);
          }
          return result;
        } catch (error) {
          const errorType = safeErrorType(error);
          const failure = failureAttributes(
            "inspect_correlated_trace_and_result_before_retry",
            "mcp_request_failed",
            "mcp_handler"
          );
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute("error.type", errorType);
          metricAttributes = { ...metricAttributes, "error.type": errorType };
          telemetryLog("error", "MCP operation failed", {
            ...metricAttributes,
            ...failure,
          } as TelemetryAttributes);
          captureTelemetryException(error, {
            ...failure,
            "mcp.method.name": method,
            "network.transport": transport === "stdio" ? "pipe" : "tcp",
            "error.type": errorType,
          });
          throw error;
        } finally {
          duration?.record(Number(process.hrtime.bigint() - startedAt) / 1_000_000_000, metricAttributes);
          span.end();
        }
      });
    });
  }) as typeof protocol.setRequestHandler;
}

export function failureAttributes(
  remediationAction: string,
  diagnosticCode: string,
  lifecycleStage: "mcp_handler" | "http_request" | "runtime_start" | "runtime_shutdown"
): TelemetryAttributes {
  return {
    action: remediationAction,
    diagnostic_code: diagnosticCode,
    failure_cause: "unobserved",
    failure_domain: "unobserved",
    lifecycle_stage: lifecycleStage,
    owner_id: "unobserved",
    retryable: "unobserved",
  };
}

export function emitTelemetryLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  attributes: TelemetryAttributes = {}
): void {
  telemetryLog(level, message, attributes);
}

export function captureTelemetryException(error: unknown, attributes: TelemetryAttributes = {}): void {
  const errorSink = active?.errorSink;
  if (!errorSink) return;
  try {
    const candidate = trace.getActiveSpan()?.spanContext();
    const spanContext = candidate && isSpanContextValid(candidate) ? candidate : undefined;
    errorSink.capture(error, attributes, spanContext);
  } catch {
    // Error telemetry is observational and must never alter MCP behavior.
    try {
      reportDiagnostic("Error telemetry capture failed; runtime continuing");
    } catch {
      // Even a broken diagnostic stream cannot take custody of the MCP result.
    }
  }
}

export async function flushTelemetry(): Promise<void> {
  const runtime = active;
  if (!runtime) return;
  await Promise.all([
    runtime.tracerProvider?.forceFlush(),
    runtime.loggerProvider?.forceFlush(),
    runtime.meterProvider?.forceFlush(),
    runtime.errorSink?.flush(),
  ]);
}

export async function stopTelemetry(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  const runtime = active;
  active = undefined;
  if (!runtime) return;
  shutdownPromise = Promise.allSettled([
    runtime.tracerProvider?.shutdown(),
    runtime.loggerProvider?.shutdown(),
    runtime.meterProvider?.shutdown(),
    runtime.errorSink?.shutdown(),
  ]).then((results) => {
    if (results.some((result) => result.status === "rejected")) reportDiagnostic("Telemetry shutdown was incomplete");
  });
  return shutdownPromise;
}
