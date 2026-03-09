/**
 * Structured logging with Winston
 */

import winston from "winston";

const isDevelopment = process.env.NODE_ENV !== "production";

export const logger = winston.createLogger({
  level: isDevelopment ? "debug" : "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "varity-mcp" },
  transports: [
    // Console output (pretty print in development, JSON in production)
    new winston.transports.Console({
      format: isDevelopment
        ? winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        : winston.format.json(),
    }),
  ],
});

// Add file transports in production
if (!isDevelopment) {
  logger.add(
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );

  logger.add(
    new winston.transports.File({
      filename: "logs/combined.log",
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );
}

/**
 * Log MCP tool call
 */
export function logToolCall(
  toolName: string,
  params: any,
  sessionId?: string
) {
  logger.info("MCP tool called", {
    tool: toolName,
    params: Object.keys(params),
    sessionId,
  });
}

/**
 * Log MCP tool result
 */
export function logToolResult(
  toolName: string,
  success: boolean,
  duration: number,
  sessionId?: string
) {
  logger.info("MCP tool completed", {
    tool: toolName,
    success,
    duration,
    sessionId,
  });
}

/**
 * Log error
 */
export function logError(
  error: Error,
  context?: Record<string, any>
) {
  logger.error("Error occurred", {
    error: error.message,
    stack: error.stack,
    ...context,
  });
}

/**
 * Log HTTP request
 */
export function logHttpRequest(
  method: string,
  path: string,
  statusCode: number,
  duration: number,
  sessionId?: string
) {
  logger.info("HTTP request", {
    method,
    path,
    statusCode,
    duration,
    sessionId,
  });
}
