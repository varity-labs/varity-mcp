import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit } from "../utils/cli-bridge.js";

export function registerRedeployTool(server: McpServer): void {
  server.registerTool(
    "varity_redeploy",
    {
      title: "Redeploy or Restart an Existing Deployment In Place",
      description:
        "Redeploy or restart an app that is ALREADY deployed, in place. Use this when a developer says " +
        "'redeploy <name>', 'restart <name>', 'my app is stuck, restart it', or 'pull the latest image and " +
        "redeploy'. The app is re-deployed on the SAME deployment. Same URL, same reserved hardware, " +
        "no extra hardware reservation. It re-pulls the image (or rebuilds from source) and restarts the container, so it goes live " +
        "in about a minute with no URL change. To change env vars at the same time, use varity_set_env. To " +
        "create a NEW deployment instead, use varity_deploy.",
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
        return successResponse(
          { name, action: "redeploy" },
          `Redeploying "${name}" in place on the same hardware and URL. It goes live in about a minute.`
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
