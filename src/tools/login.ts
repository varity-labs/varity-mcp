import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execVaritykit, execCLI } from "../utils/cli-bridge.js";
import { INFRASTRUCTURE, isAuthenticated } from "../utils/config.js";

export function registerLoginTool(server: McpServer): void {
  server.registerTool(
    "varity_login",
    {
      title: "Log in to Varity",
      description:
        "Log in to Varity to enable deployments. Opens the developer portal where you get your deploy key after adding a payment method. " +
        "If deploy_key is provided, saves it immediately and you can run varity_deploy right away. " +
        "If omitted, the browser opens to the settings page so you can copy your key.",
      inputSchema: {
        deploy_key: z
          .string()
          .optional()
          .describe(
            "Your deploy key from the Varity developer portal (developer.store.varity.so/dashboard/settings). " +
            "If omitted, this tool opens the settings page in your browser — copy your key from there, " +
            "then call varity_login again with the key."
          ),
      },
    },
    async ({ deploy_key }) => {
      if (deploy_key) {
        // Authenticate with the provided key via varitykit CLI
        const result = await execVaritykit("login", ["--key", deploy_key]);

        if (result.exitCode === 0) {
          const cliMessage = result.stdout.trim();
          return successResponse(
            {
              authenticated: true,
              deploy_key_set: true,
              ...(cliMessage ? { account_message: cliMessage } : {}),
            },
            cliMessage
              ? `Logged in to Varity successfully. ${cliMessage}`
              : "Logged in to Varity successfully. You can now run varity_deploy to deploy your app."
          );
        }

        // Login failed — surface the CLI error clearly
        const output = (result.stderr || result.stdout || "").trim();
        return errorResponse(
          "LOGIN_FAILED",
          `Login failed: ${output || "Invalid deploy key or authentication error."}`,
          "Check that your deploy key is correct. Get your key from: developer.store.varity.so/dashboard/settings"
        );
      }

      // No key provided — check if already authenticated
      const alreadyAuthenticated = await isAuthenticated();
      if (alreadyAuthenticated) {
        return successResponse(
          {
            authenticated: true,
            already_logged_in: true,
            next_step: "You are already logged in. Call varity_deploy when ready, or call varity_doctor to verify your full setup.",
          },
          "Already logged in to Varity. Your deploy key is configured — call varity_deploy when ready."
        );
      }

      // No key provided — open the settings page so the user can copy their key
      const settingsUrl = `${INFRASTRUCTURE.DEVELOPER_PORTAL}/dashboard/settings`;

      const isHeadless =
        process.env.CI === "true" ||
        process.env.HEADLESS === "true" ||
        (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

      if (isHeadless) {
        return successResponse(
          {
            authenticated: false,
            headless_environment: true,
            settings_url: settingsUrl,
            next_step:
              "Headless environment detected — browser cannot open automatically. " +
              "Get your deploy key from the settings URL, then call varity_login with: deploy_key: \"<your-key>\"",
          },
          `Headless environment detected — browser cannot open automatically.\n\nTo log in:\n1. Open on any browser: ${settingsUrl}\n2. Add a payment method if prompted\n3. Copy your deploy key from the Settings page\n4. Call varity_login again with: deploy_key: "<your-key>"`
        );
      }

      const platform = process.platform;
      const command =
        platform === "darwin" ? "open" : platform === "win32" ? "cmd.exe" : "xdg-open";
      const args = platform === "win32" ? ["/c", "start", settingsUrl] : [settingsUrl];

      let browserOpened = false;
      try {
        const openResult = await execCLI(command, args, { timeout: 10_000 });
        browserOpened = openResult.exitCode === 0;
      } catch {
        // Browser open failure is non-fatal — the URL is still returned
      }

      const message = browserOpened
        ? `Settings page opened in your browser.\n\nTo complete login:\n1. Add a payment method if prompted\n2. Copy your deploy key from the Settings page\n3. Call varity_login again with: deploy_key: "<your-key>"`
        : `Could not open browser automatically.\n\nTo complete login:\n1. Open: ${settingsUrl}\n2. Add a payment method if prompted\n3. Copy your deploy key from the Settings page\n4. Call varity_login again with: deploy_key: "<your-key>"`;

      return successResponse(
        {
          authenticated: false,
          browser_opened: browserOpened,
          settings_url: settingsUrl,
          next_step:
            "Copy your deploy key from the Settings page, then call varity_login again with: deploy_key: \"<your-key>\"",
        },
        message
      );
    }
  );
}
