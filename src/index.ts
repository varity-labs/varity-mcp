#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createVarityServer, VERSION } from "./server.js";
import type { TransportMode } from "./server.js";
import { logger, logHttpRequest } from "./utils/logger.js";
import {
  captureTelemetryException,
  failureAttributes,
  startTelemetry,
  stopTelemetry,
} from "./telemetry.js";
import {
  createRuntimeShutdownCoordinator,
  type RuntimeShutdown,
} from "./runtime-shutdown.js";

/**
 * Varity MCP Server
 *
 * Transports:
 *   stdio, For Cursor, Claude Code, Windsurf, VS Code (default)
 *   http, For Claude.ai, ChatGPT, browser-based clients
 *
 * Usage:
 *   npx -y @varity-labs/mcp                             # stdio (default)
 *   npx -y @varity-labs/mcp --transport http --port 3100 # HTTP mode
 *
 * Cursor (.cursor/mcp.json):
 *   { "mcpServers": { "varity": { "command": "npx", "args": ["-y", "@varity-labs/mcp"] } } }
 *
 * Claude Code:
 *   claude mcp add varity -- npx -y @varity-labs/mcp
 */

interface ParsedArgs {
  transport: TransportMode;
  port: number;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let transport: TransportMode = "stdio";
  let port = 3100;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--transport" && args[i + 1]) {
      const value = args[i + 1]!;
      if (value === "stdio" || value === "http") {
        transport = value;
      }
      i++;
    } else if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.error(`@varity-labs/mcp v${VERSION}`);
      process.exit(0);
    }
  }

  return { transport, port };
}

function printHelp(): void {
  console.error(`
@varity-labs/mcp v${VERSION} - Deploy production apps from any AI coding tool

USAGE:
  npx -y @varity-labs/mcp [options]

OPTIONS:
  --transport stdio|http  Transport type (default: stdio)
  --port <number>         HTTP port (default: 3100, only for --transport http)
  --help, -h              Show this help
  --version, -v           Show version

TOOLS:
  varity_search_docs       Search Varity documentation
  varity_cost_calculator   Estimate the fixed monthly price for a deployment profile
  varity_create_repo       Create a GitHub repo from your local project (HTTP/stdio)
  varity_deploy            Deploy to production
  varity_deploy_status     Check deployment status
  varity_deploy_logs       Read build/deployment logs

CURSOR (.cursor/mcp.json):
  {
    "mcpServers": {
      "varity": {
        "command": "npx",
        "args": ["-y", "@varity-labs/mcp"]
      }
    }
  }

CLAUDE CODE:
  claude mcp add varity -- npx -y @varity-labs/mcp

HOSTED (Claude.ai / ChatGPT):
  URL: https://mcp.varity.so

DOCS: https://docs.varity.so/ai-tools/mcp-server-spec
`);
}

async function startStdio(onTransportClose: () => void): Promise<RuntimeShutdown> {
  const server = createVarityServer("stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    onTransportClose();
  };
  // The SDK listens for stdin data/error but does not translate EOF into
  // transport.close(), so the process must take telemetry custody explicitly.
  process.stdin.once("end", onTransportClose);
  return async () => {
    process.stdin.off("end", onTransportClose);
    await server.close();
  };
}

async function startHttp(port: number): Promise<RuntimeShutdown> {
  // Dynamic imports
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");

  // Track server+transport pairs by session ID
  // Each session gets its own McpServer instance (SDK requires 1:1 server:transport)
  const sessions = new Map<string, { server: ReturnType<typeof createVarityServer>; transport: StreamableHTTPServerTransport }>();

  // Rate limiting: 100 requests/minute per IP
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT = 100;
  const RATE_WINDOW = 60000; // 1 minute

  function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
      return true;
    }

    if (entry.count >= RATE_LIMIT) {
      return false;
    }

    entry.count++;
    return true;
  }

  const httpServer = createServer(async (req, res) => {
    const startTime = Date.now();
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

    try {
      // Security headers (Helmet-like)
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-XSS-Protection", "1; mode=block");
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

      // Health check (bypass rate limit)
      if (url.pathname === "/health" || url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: VERSION, transport: "http" }));
        logHttpRequest(req.method || "GET", url.pathname, 200, Date.now() - startTime);
        return;
      }

      // Rate limiting
      if (!checkRateLimit(clientIp)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Too many requests. Try again in 1 minute." }));
        logHttpRequest(req.method || "?", url.pathname, 429, Date.now() - startTime);
        logger.warn("Rate limit exceeded");
        return;
      }

      // CORS headers for browser-based clients
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        logHttpRequest("OPTIONS", url.pathname, 204, Date.now() - startTime);
        return;
      }

      // MCP endpoint
      if (url.pathname === "/mcp") {
        // Check for existing session
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Reuse existing session
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
          logHttpRequest(req.method || "POST", url.pathname, res.statusCode, Date.now() - startTime);
          return;
        }

        // New session, create a fresh server + transport pair
        if (req.method === "POST" && !sessionId) {
          const sessionServer = createVarityServer("http");
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              sessions.delete(transport.sessionId);
              logger.info("MCP session closed");
            }
          };

          await sessionServer.connect(transport);
          await transport.handleRequest(req, res);

          // Session ID is assigned after handleRequest processes the initialize message
          if (transport.sessionId) {
            sessions.set(transport.sessionId, { server: sessionServer, transport });
            logger.info("New MCP session created");
          }

          logHttpRequest("POST", url.pathname, res.statusCode, Date.now() - startTime);
          return;
        }

        // Invalid request
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request. POST to /mcp to start a session." }));
        logHttpRequest(req.method || "?", url.pathname, 400, Date.now() - startTime);
        return;
      }

      // 404 for unknown paths
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use /mcp for MCP protocol, / for health check." }));
      logHttpRequest(req.method || "?", url.pathname, 404, Date.now() - startTime);
    } catch (error) {
      // Catch-all error handler
      const err = error instanceof Error ? error : new Error(String(error));
      const failure = failureAttributes(
        "inspect_correlated_trace_and_response_before_retry",
        "http_request_failed",
        "http_request"
      );
      logger.error("HTTP request error", {
        ...failure,
        "so.varity.mcp.operation.name": "http_request",
        "error.type": err.name,
        "url.path": url.pathname,
        "http.request.method": req.method ?? "?",
      });
      captureTelemetryException(err, {
        ...failure,
        "so.varity.mcp.operation.name": "http_request",
        "error.type": err.name,
      });

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Internal server error",
        ...(process.env.NODE_ENV !== "production" ? { details: err.message } : {})
      }));
      logHttpRequest(req.method || "?", url.pathname, 500, Date.now() - startTime);
    }
  });

  // Akash ingress reaches the pod over IPv4. Node hostless listen defaults to an IPv6
  // wildcard and only accepts IPv4 when the node permits mapped addresses.
  await new Promise<void>((resolve) => httpServer.listen({ port, host: "0.0.0.0" }, resolve));
  {
    logger.info(`Varity MCP Server v${VERSION} running on http://localhost:${port}/mcp`);
    logger.info(`Health check: http://localhost:${port}/health`);
    logger.info(`Rate limit: ${RATE_LIMIT} requests/minute per IP`);
  }

  return () => new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else {
        logger.info("HTTP server closed");
        resolve();
      }
    });
  });
}

async function main(): Promise<void> {
  const { transport, port } = parseArgs();
  startTelemetry({ version: VERSION, transport });
  const shutdown = createRuntimeShutdownCoordinator(stopTelemetry);

  if (transport === "stdio") {
    shutdown.setRuntimeShutdown(await startStdio(() => {
      void shutdown.shutdown(false).catch(() => {
        logger.error("Runtime shutdown failed", {
          ...failureAttributes(
            "inspect_shutdown_diagnostics_before_restart",
            "runtime_shutdown_failed",
            "runtime_shutdown"
          ),
          "so.varity.mcp.operation.name": "runtime_shutdown",
        });
        process.exitCode = 1;
      });
    }));
  } else if (transport === "http") {
    shutdown.setRuntimeShutdown(await startHttp(port));
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info(`${signal} received, shutting down gracefully`);
      void shutdown.shutdown(true).then(
        () => process.exit(0),
        () => {
          logger.error("Runtime shutdown failed", {
            ...failureAttributes(
              "inspect_shutdown_diagnostics_before_restart",
              "runtime_shutdown_failed",
              "runtime_shutdown"
            ),
            "so.varity.mcp.operation.name": "runtime_shutdown",
          });
          process.exit(1);
        }
      );
    });
  }

  // Readiness promises signal-safe shutdown custody to the parent process.
  if (transport === "stdio") {
    console.error(`Varity MCP Server v${VERSION} running on stdio`);
  }
}

main().catch((error) => {
  const err = error instanceof Error ? error : new Error(String(error));
  const failure = failureAttributes(
    "inspect_runtime_configuration_and_error_before_restart",
    "runtime_start_failed",
    "runtime_start"
  );
  logger.error("Fatal error", {
    ...failure,
    "so.varity.mcp.operation.name": "runtime_start",
    "error.type": err.name,
  });
  captureTelemetryException(err, {
    ...failure,
    "so.varity.mcp.operation.name": "runtime_start",
    "error.type": err.name,
  });
  void stopTelemetry().finally(() => process.exit(1));
});
