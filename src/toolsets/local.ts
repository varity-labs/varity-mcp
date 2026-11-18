import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "../resources/index.js";
import { registerPrompts } from "../prompts/index.js";
import { registerSearchDocsTool } from "../tools/search-docs.js";
import { registerCostCalculatorTool } from "../tools/cost-calculator.js";
import { registerBalanceTool } from "../tools/balance.js";
import { registerCreateRepoTool } from "../tools/create-repo.js";
import { registerDeployTool } from "../tools/deploy.js";
import { localDeploySource } from "../tools/deploy-local-source.js";
import { registerDeployStatusTool } from "../tools/deploy-status.js";
import { registerDeployLogsTool } from "../tools/deploy-logs.js";
import { registerDoctorTool } from "../tools/doctor.js";
import { registerInstallDepsTool } from "../tools/install-deps.js";
import { registerBuildTool } from "../tools/build.js";
import { registerOpenBrowserTool } from "../tools/open-browser.js";
import { registerDevServerTool } from "../tools/dev-server.js";
import { registerLoginTool, registerLogoutTool } from "../tools/login.js";
import { registerMigrateTool } from "../tools/migrate.js";
import { registerAgentTools } from "../tools/agent.js";
import { registerDeleteDeploymentTool } from "../tools/delete-deployment.js";
import { registerSetEnvTool } from "../tools/set-env.js";
import { readProjectEnv } from "../tools/env-file.js";
import { registerDomainTools } from "../tools/domain.js";
import { registerRedeployTool } from "../tools/redeploy.js";
import { registerMachinesTools } from "../tools/machines.js";

/**
 * The stdio toolset: the complete local surface for a coding client on the
 * invoking user's machine, including filesystem and process tools.
 *
 *   - Discovery: search-docs, cost-calculator, doctor
 *   - Setup: install-deps, build, login, logout
 *   - Deploy own code: deploy, deploy-status, deploy-logs, delete-deployment
 *   - Operate: set-env (values from the project's .env, restarts the app); custom domain add/verify/remove; redeploy (restart of the last successful release at its saved commit)
 *   - CPU and GPU VMs: machines-list, machines-create (caller's SSH public key), machines-delete (waits for billing stop)
 *   - Deploy certified templates: list-templates, template-info, deploy-template
 *   - Local development: open-browser, dev-server
 *   - Project ops: create-repo, migrate
 */
export function registerLocalToolset(server: McpServer): void {
  // ── Resources (stable routes to live owners) ──
  registerResources(server);

  // ── Prompts (local workflows may use filesystem/process tools) ──
  registerPrompts(server);

  // ── Local discovery tools ──
  registerSearchDocsTool(server);
  registerCostCalculatorTool(server);
  registerBalanceTool(server);
  registerDoctorTool(server);

  // ── Development tools (stdio owns the caller's local filesystem) ──
  registerLoginTool(server);
  registerLogoutTool(server);
  registerInstallDepsTool(server);
  registerBuildTool(server);
  registerOpenBrowserTool(server);
  registerDevServerTool(server);

  // ── Deployment and project tools (stdio only) ──
  registerCreateRepoTool(server);
  registerDeployTool(server, localDeploySource);
  registerDeployStatusTool(server);
  registerDeployLogsTool(server);
  registerDeleteDeploymentTool(server);
  registerSetEnvTool(server);
  registerDomainTools(server);
  registerRedeployTool(server);
  registerMachinesTools(server);
  registerAgentTools(server, readProjectEnv);
  registerMigrateTool(server);
}
