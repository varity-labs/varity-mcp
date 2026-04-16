import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { INFRASTRUCTURE, getDeploymentsDir, getApiKey } from "../utils/config.js";
import { execCLI } from "../utils/cli-bridge.js";

export function registerSubmitToStoreTool(server: McpServer): void {
  server.registerTool(
    "varity_submit_to_store",
    {
      title: "Submit App to Store",
      description:
        "Submit a deployed app to the Varity App Store for monetization. " +
        "💡 TIP: Pass confirm: true to attempt direct API submission — no browser click required if the API is reachable. " +
        "Default (without confirm: true) is a 2-step process: Step 1 generates a pre-filled URL and opens it in your browser; Step 2 requires clicking Submit on that page. " +
        "Pass skip_browser: true to suppress the browser open and return only the URL (useful for CI/CD pipelines or headless environments). " +
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
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Set to true to attempt direct API submission without a browser click. " +
            "The tool calls the developer portal API and retries 3 times before giving up. " +
            "If the API is unavailable (e.g. HTTP 405 or network error), the tool returns " +
            "submission_status: 'api_unavailable' with confirm_failed: true and a pre-filled " +
            "submission URL — it does NOT silently open a browser. " +
            "On api_unavailable: open the returned submission_url to complete listing manually (takes under a minute). " +
            "Recommended for CI/CD pipelines; falls back gracefully when the API is down."
          ),
      },
      annotations: {
        destructiveHint: true, // Publishes to a public store
      },
    },
    async ({ deployment_id, name, description, price, skip_browser, confirm }) => {
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

      // ── Programmatic submission path (confirm: true) ──────────────────────
      // Attempt a direct POST to the developer portal API so no browser click
      // is required. When the API is unavailable, return a distinct status
      // (api_unavailable) rather than silently falling back to browser mode —
      // the caller explicitly chose confirm: true to avoid browser interaction.
      if (confirm) {
        let apiSucceeded = false;
        let lastApiStatus = 0;
        // Retry with exponential backoff: attempt 1 (immediate), attempt 2 (+2s), attempt 3 (+6s)
        // This handles transient failures (network blip, cold start) without returning api_unavailable
        // for a one-off hiccup on what should be a highly-available endpoint.
        const RETRY_DELAYS_MS = [0, 2_000, 6_000];

        // Include the user's API key so the submission endpoint can authenticate the request.
        const apiKey = await getApiKey();
        const apiHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) {
          apiHeaders["Authorization"] = `Bearer ${apiKey}`;
        }

        for (let attempt = 0; attempt < RETRY_DELAYS_MS.length && !apiSucceeded; attempt++) {
          if (RETRY_DELAYS_MS[attempt]! > 0) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]!));
          }
          try {
            const apiResponse = await fetch(`${INFRASTRUCTURE.DEVELOPER_PORTAL}/api/submit`, {
              method: "POST",
              headers: apiHeaders,
              body: JSON.stringify({ deployment_id, name, description, price }),
              signal: AbortSignal.timeout(15_000),
            });
            lastApiStatus = apiResponse.status;
            if (apiResponse.ok) {
              apiSucceeded = true;
            }
          } catch {
            // Network error or timeout — continue to next retry attempt
          }
        }

        if (apiSucceeded) {
            return successResponse(
              {
                submission_status: "submitted",
                action_required: false,
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
                review_timeline: "Automated verification runs immediately (security scan, functional test). Apps typically appear in the store within 1–4 hours. Check status at developer.store.varity.so.",
                next_steps: [
                  "✅ App submitted to the Varity App Store directly via API",
                  "Automated verification is now running (security scan, functional test)",
                  "App will appear on store.varity.so after review — typically within 1–4 hours",
                  "Monitor submission status at developer.store.varity.so",
                  revenueNote,
                ],
                store_url: INFRASTRUCTURE.APP_STORE,
                developer_portal: INFRASTRUCTURE.DEVELOPER_PORTAL,
              },
              `App "${name}" submitted to the App Store successfully (no browser required).`
            );
        }

        if (!apiSucceeded) {
          // The caller passed confirm: true specifically to avoid browser interaction.
          // Do NOT silently fall back to browser mode — return a clear error so CI/CD
          // scripts can detect and retry rather than getting stuck on action_required.
          const params = new URLSearchParams({ deployment_id, name, description, price: String(price) });
          const submissionUrl = `${INFRASTRUCTURE.DEVELOPER_PORTAL}/submit?${params.toString()}`;

          const apiHint =
            lastApiStatus === 401 || lastApiStatus === 403
              ? "Authentication failed — run `varitykit login` to refresh your credentials, then retry."
              : lastApiStatus === 404
              ? "Submission endpoint not found — the API may be temporarily unavailable. Use Option 2 below to submit manually."
              : lastApiStatus === 405
              ? "The submission API is not accepting requests at this time (HTTP 405). Use Option 2 below to complete your listing manually via the developer portal — it takes under a minute."
              : lastApiStatus >= 500
              ? "Server error on the submission endpoint — check https://status.varity.so and retry in a few minutes."
              : "Check https://status.varity.so for platform status, then retry.";

          return successResponse(
            {
              submission_status: "api_unavailable",
              action_required: true,
              confirm_failed: true,
              api_status_code: lastApiStatus || undefined,
              api_hint: apiHint,
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
                note: revenueNote,
              },
              next_steps: [
                `⚠️ Direct API submission unavailable (HTTP ${lastApiStatus || "no response"}) — ${apiHint}`,
                "Option 1 (retry): Call varity_submit_to_store again with confirm: true in a few minutes",
                `Option 2 (manual): Open this URL and click Submit to complete the listing: ${submissionUrl}`,
                "Option 3 (url only): Call varity_submit_to_store without confirm: true — the tool returns the submission URL without opening a browser",
              ],
              store_url: INFRASTRUCTURE.APP_STORE,
              developer_portal: INFRASTRUCTURE.DEVELOPER_PORTAL,
            },
            `Could not submit directly via API (HTTP ${lastApiStatus || "no response"}). ${apiHint}\n\nSubmission URL returned for manual completion:\n\n${submissionUrl}`
          );
        }
      }

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
