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

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): Level {
  const requested = process.env.VARITY_MCP_LOG_LEVEL as Level | undefined;
  if (requested && requested in LEVELS) return requested;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[configuredLevel()]) return;
  // console.error writes to stderr.
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: "varity-mcp",
      message,
      ...meta,
    })
  );
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
  duration: number,
  sessionId?: string
): void {
  emit("info", "HTTP request", { method, path, statusCode, duration, sessionId });
}
