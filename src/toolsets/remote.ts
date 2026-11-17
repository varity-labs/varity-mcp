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
  registerDeployStatusTool(server);
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
  "Varity puts the user's app online at a live URL. Work in this order: " +
  "1) varity_cost_calculator (or varity_template_info) to show the monthly price before deploying; " +
  "2) varity_deploy with a public repo_url or image, or varity_deploy_template; " +
  "3) varity_deploy_status until it is live or failed; " +
  "4) varity_show_deployment to show the card with the URL. " +
  "A deployment keeps running and is charged to the user's Varity account until deleted: " +
  "delete anything the user does not want with varity_delete_deployment.";
