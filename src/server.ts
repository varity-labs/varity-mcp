import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { registerSearchDocsTool } from "./tools/search-docs.js";
import { registerCostCalculatorTool } from "./tools/cost-calculator.js";
import { registerCreateRepoTool } from "./tools/create-repo.js";
import { registerDeployTool } from "./tools/deploy.js";
import { registerDeployStatusTool } from "./tools/deploy-status.js";
import { registerDeployLogsTool } from "./tools/deploy-logs.js";
import { registerDoctorTool } from "./tools/doctor.js";
import { registerInstallDepsTool } from "./tools/install-deps.js";
import { registerBuildTool } from "./tools/build.js";
import { registerOpenBrowserTool } from "./tools/open-browser.js";
import { registerDevServerTool } from "./tools/dev-server.js";
import { registerLoginTool } from "./tools/login.js";
import { registerMigrateTool } from "./tools/migrate.js";
import { registerAgentTools } from "./tools/agent.js";
import { registerDeleteDeploymentTool } from "./tools/delete-deployment.js";
import { registerSetEnvTool } from "./tools/set-env.js";
import { registerRedeployTool } from "./tools/redeploy.js";
import { createOAuthProvider } from "./auth/provider.js";
import { instrumentMcpServer } from "./telemetry.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("MCP package version is missing");
}

export const VERSION = packageMetadata.version;

export type TransportMode = "stdio" | "http";

/**
 * Create and configure the Varity MCP Server.
 *
 * This package is the published Varity MCP server. It exposes Varity's supported
 * deploy and operate surface to AI coding tools (Cursor, Claude Code, Codex, etc.)
 * so they can scaffold, build, ship, and manage apps for the user.
 *
 * Tool surface:
 *   - Discovery: search-docs, cost-calculator, doctor
 *   - Setup: install-deps, build, login
 *   - Deploy own code: deploy, deploy-status, deploy-logs, delete-deployment
 *   - Operate: set-env, redeploy (trackable configuration reapply; not verified restart)
 *   - Deploy certified templates: list-templates, template-info, deploy-template
 *   - Hosted HTTP: authenticated live documentation search only
 *   - Local-dev (stdio only): open-browser, dev-server
 *   - Project ops: create-repo, migrate
 */
export function createVarityServer(
  mode: TransportMode = "stdio",
  httpAuthProvider?: OAuthServerProvider,
): McpServer {
  const authProvider = mode === "http"
    ? httpAuthProvider ?? createOAuthProvider()
    : undefined;
  const server = new McpServer({
    name: "varity",
    version: VERSION,
    ...(authProvider ? { authProvider } : {}),
  });

  // Instrument the registration seam once so every resource, prompt, and tool
  // runs inside the same secret-safe MCP server span implementation.
  instrumentMcpServer(server, mode);

  // Hosted HTTP is intentionally a minimal authenticated public-read surface.
  // It never touches the server filesystem, spawns a process, mutates Varity,
  // or reads customer data through the host's deploy key.
  if (mode === "http") {
    registerSearchDocsTool(server);
    return server;
  }

  // ── Resources (deploy reference for local AI context) ──
  registerResources(server);

  // ── Prompts (local workflows may use filesystem/process tools) ──
  registerPrompts(server);

  // ── Local discovery tools ──
  registerSearchDocsTool(server);
  registerCostCalculatorTool(server);
  registerDoctorTool(server);

  // ── Development tools (stdio owns the caller's local filesystem) ──
  registerLoginTool(server);
  registerInstallDepsTool(server);
  registerBuildTool(server);
  registerOpenBrowserTool(server);
  registerDevServerTool(server);

  // ── Deployment and project tools (stdio only) ──
  registerCreateRepoTool(server);
  registerDeployTool(server);
  registerDeployStatusTool(server);
  registerDeployLogsTool(server);
  registerDeleteDeploymentTool(server);
  registerSetEnvTool(server);
  registerRedeployTool(server);
  registerAgentTools(server);
  registerMigrateTool(server);

  return server;
}
