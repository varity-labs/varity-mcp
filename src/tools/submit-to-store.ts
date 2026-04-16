import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { INFRASTRUCTURE, getDeploymentsDir } from "../utils/config.js";
import { execCLI } from "../utils/cli-bridge.js";

export function registerSubmitToStoreTool(server: McpServer): void {
  server.registerTool(
    "varity_submit_to_store",
    {
      title: "Submit App to Store",
      description:
        "Submit a deployed app to the Varity App Store for monetization. " +
        "Generates a pre-filled submission URL and opens it in your browser. " +
        "You must click Submit on that page to finalize — submission requires a manual review step. " +
        "Pass skip_browser: true to return only the URL without opening a browser (useful for CI/CD pipelines or headless environments). " +
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
        skip_browser: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Set to true to skip opening the browser and return only the submission URL. " +
            "Useful for CI/CD pipelines or headless environments where browser automation is not available."
          ),
      },
      annotations: {
        destructiveHint: true, // Publishes to a public store
      },
    },
    async ({ deployment_id, name, description, price, skip_browser }) => {
      // Validate that the deployment exists before generating a submission URL
      try {
        const deploymentFile = join(getDeploymentsDir(), `${deployment_id}.json`);
        await readFile(deploymentFile, "utf-8");
      } catch {
        return errorResponse(
          "DEPLOYMENT_NOT_FOUND",
          `Deployment "${deployment_id}" not found. Cannot submit a non-existent deployment to the App Store.`,
          "Run varity_deploy first to deploy your app, then use the returned deployment ID. Run varity_deploy_status to list existing deployments."
        );
      }

      const developerRevenue = (price * 0.9).toFixed(2);
      const revenueNote =
        price > 0
          ? `Users pay $${price}/month — you receive $${developerRevenue}/month per user (90% of $${price})`
          : "Free apps can still generate revenue through in-app features";

      // Build the submission URL with query params
      const params = new URLSearchParams({
        deployment_id,
        name,
        description,
        price: String(price),
      });

      const submissionUrl = `${INFRASTRUCTURE.DEVELOPER_PORTAL}/submit?${params.toString()}`;

      // Auto-open the submission page so the developer doesn't need a second tool call.
      // Skip the open attempt when:
      //   - skip_browser: true was passed explicitly (CI/CD pipelines, headless environments)
      //   - Running in a CI environment (process.env.CI=true)
      //   - Running headlessly on Linux (no DISPLAY/WAYLAND_DISPLAY)
      // Note: xdg-open exits 0 even when no display is available, so we detect headless
      // proactively rather than relying on the exit code (which would give a misleading
      // browser_opened: true in CI).
      const isHeadless =
        skip_browser === true ||
        process.env.CI === "true" ||
        process.env.HEADLESS === "true" ||
        (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

      let browserOpened = false;
      if (!isHeadless) {
        try {
          const platform = process.platform;
          const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd.exe" : "xdg-open";
          const args = platform === "win32" ? ["/c", "start", submissionUrl] : [submissionUrl];
          const result = await execCLI(command, args, { timeout: 10_000 });
          browserOpened = result.exitCode === 0;
        } catch {
          // Browser open failure is non-fatal — the URL is still returned
        }
      }

      return successResponse(
        {
          submission_url: submissionUrl,
          submission_status: "pending_confirmation",
          action_required: true,
          browser_opened: browserOpened,
          app: {
            name,
            description,
            price: price === 0 ? "Free" : `$${price}/month`,
            deployment_id,
          },
          revenue_split: {
            developer: "90%",
            platform: "10%",
            note: revenueNote,
          },
          review_timeline: "Apps typically appear in the store within 1–4 hours of submission. Monitor status at developer.store.varity.so.",
          next_steps: [
            browserOpened
              ? "⚠️ Submission page opened in your browser — you MUST click Submit on that page to finalize (the app is NOT listed until you do)"
              : `⚠️ Open this URL and click Submit to finalize your listing: ${submissionUrl}`,
            "Review app details on the submission page, then click Submit to finalize",
            "App will appear in the store within 1–4 hours of submission",
            "Monitor approval status at developer.store.varity.so",
            revenueNote,
          ],
          store_url: INFRASTRUCTURE.APP_STORE,
          developer_portal: INFRASTRUCTURE.DEVELOPER_PORTAL,
        },
        browserOpened
          ? `Submission page opened in your browser. Review the details and click Submit to list your app on the store.\n\nSubmission URL: ${submissionUrl}`
          : `Submission page ready. Open this URL to complete listing your app:\n\n${submissionUrl}`
      );
    }
  );
}
