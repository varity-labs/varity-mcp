import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { createRequire } from "node:module";
import { instrumentMcpServer } from "./telemetry.js";
import { getApiKey } from "./utils/config.js";
import { runInCallContext, type CallContext, type CredentialProvider } from "./utils/public-api.js";
import { registerLocalToolset } from "./toolsets/local.js";
import { registerRemoteToolset, REMOTE_INSTRUCTIONS } from "./toolsets/remote.js";

export type { CredentialProvider };

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("MCP package version is missing");
}

export const VERSION = packageMetadata.version;

/**
 * Every tool's raw input shape becomes a strict object, so an undeclared
 * argument is refused with the accepted names instead of silently dropped
 * (the advertised JSON schema already says `additionalProperties: false`).
 * One seam for all tools; a tool keeps writing a plain shape.
 */
export function strictToolInputs(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: { inputSchema?: unknown }, cb: unknown) => {
    const shape = config.inputSchema;
    if (!shape || typeof shape !== "object" || shape instanceof z.ZodType) return register(name, config, cb);
    const accepted = Object.keys(shape);
    const message = accepted.length === 0
      ? `${name} takes no arguments; call it with {}.`
      : `Unknown argument. ${name} accepts only: ${accepted.join(", ")}.`;
    return register(name, {
      ...config,
      inputSchema: z.strictObject(shape as ZodRawShape, {
        error: (issue) => issue.code === "unrecognized_keys" ? message : undefined,
      }),
    }, cb);
  };
}

/**
 * Every tool callback runs inside its server's call context, so the public
 * client reads this server's credential and client identity even when many
 * servers share one process (IF-SERVER-FACTORY).
 */
function bindCallContext(server: McpServer, context: CallContext): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: unknown, cb: (...args: unknown[]) => unknown) =>
    register(name, config, (...args: unknown[]) => runInCallContext(context, () => cb(...args)));
}

export interface VarityServerOptions {
  /**
   * Returns the upstream public-API bearer for each call. Default for
   * `"local"`: the stdio deploy-key order (`src/utils/config.ts`). Default for
   * `"remote"`: none (every call is NOT_AUTHENTICATED); the hosted mount
   * always passes its grant-bound key here.
   */
  credentialProvider?: CredentialProvider;
  /** `"local"` (default): the stdio surface. `"remote"`: the hosted 12-tool surface. */
  toolset?: "local" | "remote";
}

/**
 * Create and configure the Varity MCP Server (IF-SERVER-FACTORY, package
 * export `@varity-labs/mcp/server`).
 *
 * The stdio package calls `createVarityServer()` and gets the complete local
 * surface (`src/toolsets/local.ts`). The hosted mount builds one server per
 * request with `{ toolset: "remote", credentialProvider }` and gets the
 * remote surface (`src/toolsets/remote.ts`): no filesystem, process or
 * credential tool, explain-only billing copy and MCP `instructions`.
 */
export function createVarityServer(options: VarityServerOptions = {}): McpServer {
  const remote = options.toolset === "remote";
  const server = new McpServer(
    { name: "varity", version: VERSION },
    remote ? { instructions: REMOTE_INSTRUCTIONS } : undefined
  );

  // Instrument the registration seam once so every resource, prompt, and tool
  // runs inside the same secret-safe MCP server span implementation.
  instrumentMcpServer(server);
  strictToolInputs(server);
  // The public-API User-Agent names the client from `initialize`.
  bindCallContext(server, {
    credentials: options.credentialProvider ?? (remote ? async () => null : getApiKey),
    transport: remote ? "streamable_http" : "stdio",
    clientInfo: () => server.server.getClientVersion(),
  });

  if (remote) registerRemoteToolset(server);
  else registerLocalToolset(server);
  return server;
}
