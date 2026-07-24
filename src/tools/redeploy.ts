import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit, lifecycleTracking } from "../utils/cli-bridge.js";

export function registerRedeployTool(server: McpServer): void {
  server.registerTool(
    "varity_redeploy",
    {
      title: "Reapply an Existing Deployment Configuration",
      description:
        "Reapply the saved configuration for an app that is ALREADY deployed. Use this when a developer " +
        "explicitly asks to reapply or redeploy that saved configuration. The app keeps the same deployment and URL. " +
        "An unchanged configuration may be a no-op, so this tool must not " +
        "be presented as a verified restart for a stuck app. To change environment variables at the same time, " +
        "use varity_set_env. To create a NEW deployment instead, use varity_deploy.",
      inputSchema: {
        name: z
          .string()
          .describe(
            "The subdomain / app name of the existing deployment to redeploy, the slug in https://varity.app/<name>/. Example: 'my-api'."
          ),
      },
    },
    async ({ name }) => {
      if (!name || !name.trim()) {
        return errorResponse(
          "MISSING_NAME",
          "Deployment name is required.",
          "Ask the user for the app name they want to redeploy. It is the slug in their varity.app URL."
        );
      }
      if (name.startsWith("-")) {
        return errorResponse("INVALID_NAME", `Invalid app name: "${name}".`, "App names can't start with '-'.");
      }

      // `--` stops the CLI's flag parsing so the app name is never read as a flag.
      const result = await execVaritykit("app", ["redeploy", "--", name], { timeout: 120_000 });

      if (result.exitCode === 0) {
        const tracking = lifecycleTracking(result.stdout);
        return successResponse(
          {
            name,
            action: "redeploy",
            status: tracking.runId ? "redeploying" : "outcome_unconfirmed",
            run_id: tracking.runId,
            status_command: tracking.statusCommand,
          },
          tracking.statusCommand
            ? `Reapply accepted for "${name}" on the same app URL. Track its terminal outcome with: ${tracking.statusCommand}`
            : `The reapply command returned success for "${name}" without a durable tracking reference. The terminal outcome is not proven; upgrade varitykit and inspect varity_deploy_status before retrying.`
        );
      }

      const errorOutput = (result.stderr || result.stdout || "").trim();
      if (errorOutput.toLowerCase().includes("not found") || errorOutput.toLowerCase().includes("404")) {
        return errorResponse(
          "DEPLOYMENT_NOT_FOUND",
          `No deployment found with name "${name}".`,
          'Check the exact name at https://varity.app/dashboard, or run "varitykit app list" to see active deployments.'
        );
      }
      return errorResponse(
        "REDEPLOY_FAILED",
        `Could not redeploy "${name}".`,
        errorOutput || "Try again in a moment, or confirm the app is a dynamic deployment that supports in-place redeploy."
      );
    }
  );
}
