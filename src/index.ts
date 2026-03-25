#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createVarityServer, VERSION } from "./server.js";
import type { TransportMode } from "./server.js";
import { initSentry, captureException } from "./utils/monitoring.js";
import { logger, logHttpRequest } from "./utils/logger.js";

/**
 * Varity MCP Server
 *
 * Transports:
 *   stdio  — For Cursor, Claude Code, Windsurf, VS Code (default)
 *   http   — For Claude.ai, ChatGPT, browser-based clients
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
@varity-labs/mcp v${VERSION} — Deploy production apps from any AI coding tool

USAGE:
  npx -y @varity-labs/mcp [options]

OPTIONS:
  --transport stdio|http  Transport type (default: stdio)
  --port <number>         HTTP port (default: 3100, only for --transport http)
  --help, -h              Show this help
  --version, -v           Show version

TOOLS:
  varity_search_docs       Search Varity documentation
  varity_cost_calculator   Compare costs vs AWS/Vercel
  varity_init              Create a new production app (stdio only)
  varity_create_repo       Create GitHub repo with template (HTTP/stdio)
  varity_deploy            Deploy to production
  varity_deploy_status     Check deployment status
  varity_deploy_logs       Read build/deployment logs
  varity_submit_to_store   Submit to Varity App Store

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

async function startStdio(): Promise<void> {
  const server = createVarityServer("stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Varity MCP Server v${VERSION} running on stdio`);
}

async function startHttp(port: number): Promise<void> {
  // Initialize production services
  initSentry();

  // Dynamic imports
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const rateLimit = (await import("express-rate-limit")).default;
  const helmet = (await import("helmet")).default;

  const server = createVarityServer("http");

  // Track transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

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
        logger.warn("Rate limit exceeded", { ip: clientIp });
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

        if (sessionId && transports.has(sessionId)) {
          // Reuse existing transport for this session
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
          logHttpRequest(req.method || "POST", url.pathname, 200, Date.now() - startTime, sessionId);
          return;
        }

        // New session — create transport
        if (req.method === "POST" && !sessionId) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              logger.info("Session closed", { sessionId: transport.sessionId });
            }
          };

          await server.connect(transport);

          if (transport.sessionId) {
            transports.set(transport.sessionId, transport);
            logger.info("New MCP session created", { sessionId: transport.sessionId, ip: clientIp });
          }

          await transport.handleRequest(req, res);
          logHttpRequest("POST", url.pathname, 200, Date.now() - startTime, transport.sessionId);
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
      captureException(err, { path: url.pathname, method: req.method, ip: clientIp });
      logger.error("HTTP request error", {
        error: err.message,
        stack: err.stack,
        path: url.pathname,
        method: req.method,
        headers: req.headers
      });

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Internal server error",
        ...(process.env.NODE_ENV !== "production" ? { details: err.message } : {})
      }));
      logHttpRequest(req.method || "?", url.pathname, 500, Date.now() - startTime);
    }
  });

  httpServer.listen(port, () => {
    logger.info(`Varity MCP Server v${VERSION} running on http://localhost:${port}/mcp`);
    logger.info(`Health check: http://localhost:${port}/health`);
    logger.info(`Rate limit: ${RATE_LIMIT} requests/minute per IP`);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down gracefully");
    httpServer.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });
  });
}

async function main(): Promise<void> {
  const { transport, port } = parseArgs();

  if (transport === "stdio") {
    await startStdio();
  } else if (transport === "http") {
    await startHttp(port);
  }
}

main().catch((error) => {
  logger.error("Fatal error", { error: error instanceof Error ? error.message : String(error) });
  captureException(error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});
