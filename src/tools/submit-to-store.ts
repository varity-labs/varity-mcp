import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { INFRASTRUCTURE } from "../utils/config.js";

export function registerSubmitToStoreTool(server: McpServer): void {
  server.registerTool(
    "varity_submit_to_store",
    {
      title: "Submit to App Store",
      description:
        "Generate a submission link for the Varity App Store marketplace. " +
        "Opens the developer portal with pre-filled app details for review and confirmation. " +
        "Revenue split: 90% to developer, 10% to Varity. " +
        "Requires a deployment ID from a previous varity_deploy call. " +
        "Use this when a developer wants to monetize, sell, publish to the store, or list their app.",
      inputSchema: {
        deployment_id: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment ID format")
          .describe("The deployment ID to submit (from varity_deploy)"),
        name: z
          .string()
          .describe("Display name for the app on the store"),
        description: z
          .string()
          .describe("Short description of what the app does (shown to users)"),
        price: z
          .coerce.number()
          .min(0, "Price cannot be negative")
          .describe(
            "Monthly price in USD (use 0 for free apps)"
          ),
      },
      annotations: {
        destructiveHint: true, // Publishes to a public store
      },
    },
    async ({ deployment_id, name, description, price }) => {
      // Build the submission URL with query params
      const params = new URLSearchParams({
        deployment_id,
        name,
        description,
        price: String(price),
      });

      const submissionUrl = `${INFRASTRUCTURE.DEVELOPER_PORTAL}/submit?${params.toString()}`;

      return successResponse(
        {
          submission_url: submissionUrl,
          app: {
            name,
            description,
            price: price === 0 ? "Free" : `$${price}/month`,
            deployment_id,
          },
          revenue_split: {
            developer: "90%",
            platform: "10%",
          },
          next_steps: [
            `Open the submission page: ${submissionUrl}`,
            "Review and confirm app details",
            "App will be listed on the Varity App Store after review",
            price > 0
              ? `Users will pay $${price}/month — you receive $${(price * 0.9).toFixed(2)}/month per user`
              : "Free apps can still generate revenue through in-app features",
          ],
          store_url: INFRASTRUCTURE.APP_STORE,
          developer_portal: INFRASTRUCTURE.DEVELOPER_PORTAL,
        },
        `Ready to submit "${name}" to the Varity App Store. Open the submission page to complete: ${submissionUrl}`
      );
    }
  );
}
