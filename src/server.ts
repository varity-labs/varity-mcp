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
import { createOAuthProvider } from "./auth/provider.js";

export const VERSION = "2.0.0-beta.15";

export type TransportMode = "stdio" | "http";

/**
 * Create and configure the Varity MCP Server.
 *
 * The server provides:
 *   - 5 resources (SDK reference — database, auth, UI components, patterns, deploy)
 *   - 14 tools (scaffold, deploy, build, dev-server, add-collection, manage, search, calculate)
 *   - 3 prompts (build-app, add-feature, deploy-and-monetize)
 *
 * Resources give AI coding tools complete knowledge of the Varity SDK
 * so they can write correct code without searching docs or guessing.
 */
export function createVarityServer(mode: TransportMode = "stdio"): McpServer {
  const server = new McpServer({
    name: "varity",
    version: VERSION,
    ...(mode === "http" ? { authProvider: createOAuthProvider() } : {}),
  });

  // ── Resources (always available — SDK reference for AI context) ──
  registerResources(server);

  // ── Prompts (workflow templates for common tasks) ──
  registerPrompts(server);

  // ── Public tools (no auth required) ──
  registerSearchDocsTool(server);
  registerCostCalculatorTool(server);
  registerDoctorTool(server);

  // ── Development tools (all transports — run on MCP server's local filesystem) ──
  registerLoginTool(server);
  registerInitTool(server);
  registerInstallDepsTool(server);
  registerBuildTool(server);
  registerAddCollectionTool(server);

  // ── Local-environment tools (stdio only — require a local browser or local process on the client machine) ──
  if (mode === "stdio") {
    registerOpenBrowserTool(server);
    registerDevServerTool(server);
  }

  // ── Deployment tools (all transports) ──
  registerCreateRepoTool(server);
  registerDeployTool(server);
  registerDeployStatusTool(server);
  registerDeployLogsTool(server);
  registerSubmitToStoreTool(server);
  registerMigrateTool(server);

  return server;
}
