import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export const VERSION = "2.3.2";

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
 *   - Operate: set-env, redeploy (edit config / redeploy + restart in place)
 *   - Deploy curated AI agent templates: list-agents, agent-info, deploy-agent
 *   - Local-dev (stdio only): open-browser, dev-server
 *   - Project ops: create-repo, migrate
 */
export function createVarityServer(mode: TransportMode = "stdio"): McpServer {
  const server = new McpServer({
    name: "varity",
    version: VERSION,
    ...(mode === "http" ? { authProvider: createOAuthProvider() } : {}),
  });

  // ── Resources (deploy reference for AI context) ──
  registerResources(server);

  // ── Prompts (workflow templates for common tasks) ──
  registerPrompts(server);

  // ── Public tools (no auth required) ──
  registerSearchDocsTool(server);
  registerCostCalculatorTool(server);
  registerDoctorTool(server);

  // ── Development tools (all transports, run on MCP server's local filesystem) ──
  registerLoginTool(server);
  registerInstallDepsTool(server);
  registerBuildTool(server);

  // ── Local-environment tools (stdio only, require a local browser or local process on the client machine) ──
  if (mode === "stdio") {
    registerOpenBrowserTool(server);
    registerDevServerTool(server);
  }

  // ── Deployment tools (all transports) ──
  registerCreateRepoTool(server);
  registerDeployTool(server);
  registerDeployStatusTool(server);
  registerDeployLogsTool(server);
  registerDeleteDeploymentTool(server);

  // ── Operate tools (edit env + redeploy/restart in place) ──
  registerSetEnvTool(server);
  registerRedeployTool(server);

  // ── AI agent tools, curated templates with one-command deploy ──
  registerAgentTools(server);
  registerMigrateTool(server);

  return server;
}
