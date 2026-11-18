import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDeploymentCard } from "../apps/deployment-card.js";
import { registerSearchDocsTool } from "../tools/search-docs.js";
import { registerCostCalculatorTool } from "../tools/cost-calculator.js";
import { registerBalanceTool } from "../tools/balance.js";
import { registerTemplateTools } from "../tools/agent.js";
import { registerDeployTool } from "../tools/deploy.js";
import { registerDeployStatusTool } from "../tools/deploy-status.js";
import { registerDeployLogsTool } from "../tools/deploy-logs.js";
import { registerRedeployTool } from "../tools/redeploy.js";
import { registerDeleteDeploymentTool } from "../tools/delete-deployment.js";
import { registerShowDeploymentTool } from "../tools/show-deployment.js";
import { SERVER_RULES } from "./instructions.js";

/**
 * The remote (hosted) toolset, distribution plan N8: 12 tools, no filesystem,
 * process or credential tool, no machines, explain-only billing copy.
 * `varity_deploy` takes a repo_url or image only (no local path; `files`
 * waits for the upload interface, N25). `check:architecture` refuses this
 * module graph reaching `node:fs`, `node:child_process`, `node:os` or the CLI
 * bridge.
 */
export function registerRemoteToolset(server: McpServer): void {
  registerDeploymentCard(server);

  registerSearchDocsTool(server);
  registerCostCalculatorTool(server);
  registerBalanceTool(server);
  registerTemplateTools(server);
  registerDeployTool(server);
  // No server-side URL probe remotely (it would fetch arbitrary URLs from Varity).
  registerDeployStatusTool(server, { probe: false });
  registerDeployLogsTool(server);
  registerRedeployTool(server);
  registerDeleteDeploymentTool(server);
  registerShowDeploymentTool(server);
}

/**
 * MCP `instructions` for the remote server, at most 512 characters and
 * self-contained (some hosts read only the first 512).
 */
export const REMOTE_INSTRUCTIONS =
  "Order: 1) varity_cost_calculator or varity_template_info: monthly price; " +
  "2) varity_deploy (public repo_url or image) or varity_deploy_template; " +
  "3) varity_deploy_status until live or failed; 4) varity_show_deployment: URL. " +
  "Apps are charged until varity_delete_deployment. " +
  SERVER_RULES;
