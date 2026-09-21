#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVarityServer, VERSION } from "./server.js";
import { logger } from "./utils/logger.js";
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

/** Published stdio MCP entrypoint. */
function handleArguments(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) return;

  // Preserve the previously documented explicit stdio spelling while refusing
  // every retired or unknown transport.
  if (args.length === 2 && args[0] === "--transport" && args[1] === "stdio") {
    return;
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printHelp();
    process.exit(0);
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    console.error(`@varity-labs/mcp v${VERSION}`);
    process.exit(0);
  }

  console.error("Unsupported command-line arguments. Values are not echoed because arguments may contain credentials.");
  printHelp();
  process.exit(2);
}

function printHelp(): void {
  console.error(`
@varity-labs/mcp v${VERSION} - Use Varity from an MCP-compatible coding client

USAGE:
  npx -y @varity-labs/mcp

OPTIONS:
  --help, -h              Show this help
  --version, -v           Show version

TRANSPORT:
  stdio only. Configure this command in Cursor, Claude Code, VS Code, Windsurf,
  or another client that can launch a local MCP process.

DOCS: https://docs.varity.so/ai-tools/mcp-server-spec
`);
}

async function startStdio(onTransportClose: () => void): Promise<RuntimeShutdown> {
  const server = createVarityServer();
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

async function main(): Promise<void> {
  handleArguments();
  startTelemetry({ version: VERSION });
  const shutdown = createRuntimeShutdownCoordinator(stopTelemetry);

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
  console.error(`Varity MCP Server v${VERSION} running on stdio`);
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
