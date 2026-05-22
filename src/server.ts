import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { registerSearchDocsTool } from "./tools/search-docs.js";
import { registerCostCalculatorTool } from "./tools/cost-calculator.js";
import { registerInitTool } from "./tools/init.js";
import { registerCreateRepoTool } from "./tools/create-repo.js";
import { registerDeployTool } from "./tools/deploy.js";
import { registerDeployStatusTool } from "./tools/deploy-status.js";
import { registerDeployLogsTool } from "./tools/deploy-logs.js";
import { registerSubmitToStoreTool } from "./tools/submit-to-store.js";
import { registerDoctorTool } from "./tools/doctor.js";
import { registerInstallDepsTool } from "./tools/install-deps.js";
import { registerBuildTool } from "./tools/build.js";
import { registerOpenBrowserTool } from "./tools/open-browser.js";
import { registerDevServerTool } from "./tools/dev-server.js";
import { registerAddCollectionTool } from "./tools/add-collection.js";
import { registerLoginTool } from "./tools/login.js";
import { registerMigrateTool } from "./tools/migrate.js";
import { registerWorldModelDeployPatternsTool } from "./tools/world-model-deploy-patterns.js";
import { registerAgentTools } from "./tools/agent.js";
import { registerDeleteDeploymentTool } from "./tools/delete-deployment.js";
import { createOAuthProvider } from "./auth/provider.js";

export const VERSION = "2.0.0-beta.24";

// Tools gated behind VARITY_INTERNAL=1 because they are out of MVP scope
// (App Store, managed DB, and the internal World Model telemetry view).
// Public AI-tool consumers see the MVP-scope tools; Varity-internal consumers
// can opt in to the full set.
const SHOW_INTERNAL_TOOLS = process.env.VARITY_INTERNAL === "1";

export type TransportMode = "stdio" | "http";

/**
 * Create and configure the Varity MCP Server.
 *
 * Varity lets developers deploy any app, websites, APIs, AI agents, in 60 seconds,
 * dramatically cheaper than Vercel / Railway / Render. This MCP server exposes that
 * deploy surface to AI coding tools (Cursor, Claude Code, Codex, etc.) so they can
 * scaffold, build, and ship apps for the user.
 *
 * Tool surface (MVP scope, `VARITY_INTERNAL=1` unlocks a few more):
 *   - Discovery: search-docs, cost-calculator, doctor
 *   - Scaffold + setup: init, install-deps, build, login
 *   - Deploy own code: deploy, deploy-status, deploy-logs, delete-deployment
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

  // ── Resources (always available, SDK reference for AI context) ──
  registerResources(server);

  // ── Prompts (workflow templates for common tasks) ──
  registerPrompts(server);

  // ── Public tools (no auth required) ──
  registerSearchDocsTool(server);
  registerCostCalculatorTool(server);
  registerDoctorTool(server);

  // ── Development tools (all transports, run on MCP server's local filesystem) ──
  registerLoginTool(server);
  registerInitTool(server);
  registerInstallDepsTool(server);
  registerBuildTool(server);
  // varity_add_collection: out of MVP scope (Varity-managed DB is v2+).
  // Hidden by default; expose only when VARITY_INTERNAL=1.
  if (SHOW_INTERNAL_TOOLS) {
    registerAddCollectionTool(server);
  }

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

  // ── AI agent tools, curated templates with one-command deploy ──
  registerAgentTools(server);
  // varity_submit_to_store: App Store distribution is out of MVP scope.
  // Hidden by default.
  if (SHOW_INTERNAL_TOOLS) {
    registerSubmitToStoreTool(server);
  }
  registerMigrateTool(server);

  // world_model_deploy_patterns: internal telemetry tool, not user-facing.
  // Hidden by default; expose only when VARITY_INTERNAL=1.
  if (SHOW_INTERNAL_TOOLS) {
    registerWorldModelDeployPatternsTool(server);
  }

  return server;
}
