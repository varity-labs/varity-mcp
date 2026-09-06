import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit, lifecycleTracking } from "../utils/cli-bridge.js";

export function registerDeleteDeploymentTool(server: McpServer): void {
  server.registerTool(
    "varity_delete_deployment",
    {
      annotations: { destructiveHint: true },
      title: "Delete a Deployment and Stop Its Billing",
      description:
        "Request deletion of an existing Varity deployment by name and track it until billing stop is proven. " +
        "Use this when a developer says 'stop my <name>', 'shut down my deployment', 'I'm done with <name>', " +
        "'delete <name>', or when they no longer need a running app or agent. " +
        "The durable operation independently reconciles route removal, reserved hardware release, and billing stop. " +
        "Use varity_deploy_status or list deployments at https://varity.app/dashboard to confirm the name first if the developer is unsure.",
      inputSchema: {
        name: z
          .string()
          .describe(
            "The subdomain / app name of the deployment to delete. This is the slug in https://varity.app/<name>/. " +
              "Example: 'worker-bot' or 'mvp-static-test'."
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

      if (name.startsWith("-")) {
        return errorResponse("INVALID_NAME", `Invalid app name: "${name}".`, "App names can't start with '-'.");
      }

      // `--` stops the CLI's flag parsing so the app name is never read as a flag.
      // redeploy.ts and set-env.ts already guard this way; delete was the only
      // lifecycle mutation missing it, and it is the destructive one.
      const result = await execVaritykit("app", ["delete", "--yes", "--", name], { timeout: 120_000 });

      if (result.exitCode === 0) {
        const tracking = lifecycleTracking(result.stdout);
        return successResponse(
          {
            name,
            status: tracking.runId ? "deleting" : "outcome_unconfirmed",
            deleted: false,
            run_id: tracking.runId,
            status_command: tracking.statusCommand,
          },
          tracking.statusCommand
            ? `Delete accepted for "${name}". Route removal, reserved hardware release, and billing stop are not complete until the run reaches a terminal success. Track it with: ${tracking.statusCommand}`
            : `The delete command returned success for "${name}" without a durable tracking reference. Deletion and billing stop are not proven; upgrade varitykit and inspect varity_deploy_status before retrying.`
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
