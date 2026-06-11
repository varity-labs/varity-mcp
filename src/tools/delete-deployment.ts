import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit } from "../utils/cli-bridge.js";

export function registerDeleteDeploymentTool(server: McpServer): void {
  server.registerTool(
    "varity_delete_deployment",
    {
      title: "Delete a Deployment and Stop Its Billing",
      description:
        "Delete an existing Varity deployment by name and stop its billing immediately. " +
        "Use this when a developer says 'stop my <name>', 'shut down my deployment', 'I'm done with <name>', " +
        "'delete <name>', or when they no longer need a running app or agent. " +
        "This shuts down the running app and releases its reserved hardware, so charges stop accruing right away. " +
        "Static (CDN-hosted) deployments also stop being billed after delete. " +
        "Use varity_deploy_status or list deployments at https://varity.app/dashboard to confirm the name first if the developer is unsure.",
      inputSchema: {
        name: z
          .string()
          .describe(
            "The subdomain / app name of the deployment to delete. This is the slug in https://varity.app/<name>/. " +
              "Example: 'my-hermes-bot' or 'mvp-static-test'."
          ),
      },
    },
    async ({ name }) => {
      if (!name || !name.trim()) {
        return errorResponse(
          "MISSING_NAME",
          "Deployment name is required.",
          `Tell the user to provide the app name they want to delete, it's the slug in their varity.app URL.`
        );
      }

      const result = await execVaritykit("app", ["delete", name], { timeout: 120_000 });

      if (result.exitCode === 0) {
        return successResponse(
          {
            name,
            deleted: true,
            cli_output: result.stdout,
          },
          `Deleted deployment "${name}". Billing has stopped. The URL https://varity.app/${name}/ will return 404 within a few minutes.\n\nCLI output:\n${result.stdout}`
        );
      }

      const errorOutput = (result.stderr || result.stdout || "").trim();

      // Common case: deployment doesn't exist (typo or already deleted)
      if (errorOutput.toLowerCase().includes("not found") || errorOutput.toLowerCase().includes("404")) {
        return errorResponse(
          "DEPLOYMENT_NOT_FOUND",
          `No deployment found with name "${name}".`,
          `Check the exact name at https://varity.app/dashboard, or run "varitykit app list" in a terminal to see active deployments.`
        );
      }

      return errorResponse(
        "DELETE_FAILED",
        `Failed to delete deployment "${name}": ${errorOutput || "unknown error"}`,
        `Verify you are logged in (varity_login) and the deployment name is correct. ` +
          `If the error persists, check https://varity.app/dashboard.`
      );
    }
  );
}
