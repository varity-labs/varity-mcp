import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchDocsTool } from "./tools/search-docs.js";
import { registerCostCalculatorTool } from "./tools/cost-calculator.js";
import { registerInitTool } from "./tools/init.js";
import { registerCreateRepoTool } from "./tools/create-repo.js";
import { registerDeployTool } from "./tools/deploy.js";
import { registerDeployStatusTool } from "./tools/deploy-status.js";
import { registerDeployLogsTool } from "./tools/deploy-logs.js";
import { registerSubmitToStoreTool } from "./tools/submit-to-store.js";

export const VERSION = "1.2.0";

export type TransportMode = "stdio" | "http";

/**
 * Create and configure the Varity MCP Server.
 *
 * The server exposes 8 tools:
 *   - varity_search_docs (public)
 *   - varity_cost_calculator (public)
 *   - varity_init (authenticated — stdio only, requires local filesystem)
 *   - varity_create_repo (authenticated — HTTP/stdio, GitHub API)
 *   - varity_deploy (authenticated, requires confirmation)
 *   - varity_deploy_status (authenticated)
 *   - varity_deploy_logs (authenticated)
 *   - varity_submit_to_store (authenticated, requires confirmation)
 */
export function createVarityServer(mode: TransportMode = "stdio"): McpServer {
  const server = new McpServer({
    name: "varity",
    version: VERSION,
  });

  // Public tools (no auth required)
  registerSearchDocsTool(server);
  registerCostCalculatorTool(server);

  // Authenticated tools
  // varity_init is only available in stdio mode (requires local filesystem)
  if (mode === "stdio") {
    registerInitTool(server);
  }

  // varity_create_repo available in both modes (uses GitHub API, no filesystem)
  registerCreateRepoTool(server);

  registerDeployTool(server);
  registerDeployStatusTool(server);
  registerDeployLogsTool(server);
  registerSubmitToStoreTool(server);

  return server;
}
