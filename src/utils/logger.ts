/**
 * Structured logging for the MCP server.
 *
 * Every line goes to STDERR, never stdout. In stdio transport — the default,
 * and the only transport certified for owner-scoped operations — stdout IS the
 * JSON-RPC channel, so a single stray byte written there corrupts the MCP
 * stream for the client. Centralising the stream choice here is the point of
 * this module: individual call sites must not have to remember it.
 *
 * This replaced a Winston logger whose Console transport wrote every level,
 * including `error`, to stdout with ANSI colour codes.
 */

import { emitTelemetryLog, type TelemetryAttributes } from "../telemetry.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): Level {
  const requested = process.env.VARITY_MCP_LOG_LEVEL as Level | undefined;
  if (requested && requested in LEVELS) return requested;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const SAFE_ATTRIBUTE_KEYS = new Set([
  "action",
  "diagnostic_code",
  "duration_ms",
  "error.type",
  "failure_cause",
  "failure_domain",
  "gen_ai.operation.name",
  "gen_ai.prompt.name",
  "gen_ai.tool.name",
  "http.request.method",
  "http.response.status_code",
  "mcp.method.name",
  "network.protocol.name",
  "network.transport",
  "owner_id",
  "retryable",
  "lifecycle_stage",
  "so.varity.mcp.operation.name",
  "url.path",
]);

const SAFE_HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const SAFE_HTTP_PATHS = new Set(["/", "/health", "/mcp"]);

function sanitizeText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 512);
}

function safeAttributes(meta?: Record<string, unknown>): TelemetryAttributes {
  if (!meta) return {};
  const safe: TelemetryAttributes = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (key === "http.request.method") safe[key] = SAFE_HTTP_METHODS.has(value) ? value : "OTHER";
      else if (key === "url.path") safe[key] = SAFE_HTTP_PATHS.has(value) ? value : "/_other";
      else if ((key === "error.type" || key.startsWith("gen_ai.")) && !/^[A-Za-z0-9_.-]{1,80}$/.test(value)) {
        safe[key] = "_OTHER";
      } else safe[key] = sanitizeText(value);
    }
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    if (typeof value === "boolean") safe[key] = value;
  }
  return safe;
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[configuredLevel()]) return;
  const sanitizedMessage = sanitizeText(message);
  const attributes = safeAttributes(meta);
  // console.error writes to stderr.
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: "varity-mcp",
      message: sanitizedMessage,
      ...attributes,
    })
  );
  emitTelemetryLog(level, sanitizedMessage, attributes);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};

/**
 * Log an HTTP request served by the Streamable HTTP transport.
 */
export function logHttpRequest(
  method: string,
  path: string,
  statusCode: number,
  duration: number
): void {
  emit("info", "HTTP request", {
    "http.request.method": method,
    "url.path": path,
    "http.response.status_code": statusCode,
    duration_ms: duration,
  });
}
