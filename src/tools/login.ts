import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse } from "../utils/responses.js";
import { execCLI } from "../utils/cli-bridge.js";
import { isAuthenticated } from "../utils/config.js";
import { DEPLOY_KEY_URL } from "../utils/public-api.js";

export function configuredCredentialResponse() {
  return successResponse(
    {
      credential_present: true,
      authentication_verified: false,
      next_step: "Call varity_doctor to verify the complete deployment setup.",
    },
    "A Varity deploy credential is configured but has not been verified. Call varity_doctor before deploying."
  );
}

export function registerLoginTool(server: McpServer): void {
  server.registerTool(
    "varity_login",
    {
      title: "Set Up Varity Login",
      description:
        "Check whether a deploy key is already configured and open the developer portal settings page when login is needed. " +
        "Credentials are never accepted as MCP tool input; set VARITY_DEPLOY_KEY in the MCP server environment, or enter the deploy key only in the hidden prompt of `varitykit auth login` in a trusted terminal, which saves it to ~/.varitykit/config.json.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      if (await isAuthenticated()) {
        return configuredCredentialResponse();
      }

      const settingsUrl = DEPLOY_KEY_URL;
      const isHeadless =
        process.env.CI === "true" ||
        process.env.HEADLESS === "true" ||
        (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

      let browserOpened = false;
      if (!isHeadless) {
        const command = process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "cmd.exe"
            : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", settingsUrl] : [settingsUrl];
        const openResult = await execCLI(command, args, { timeout: 10_000 });
        browserOpened = openResult.exitCode === 0;
      }

      const nextStep =
        "Set the deploy key as VARITY_DEPLOY_KEY in the MCP server environment, or open a trusted terminal, run `varitykit auth login` and paste it only into its hidden prompt; it saves the key to ~/.varitykit/config.json. Then run varity_doctor.";
      return successResponse(
        {
          authenticated: false,
          browser_opened: browserOpened,
          headless_environment: isHeadless,
          settings_url: settingsUrl,
          next_step: nextStep,
        },
        `${browserOpened ? "Settings opened in your browser." : `Open ${settingsUrl}.`} ${nextStep}`
      );
    }
  );
}
