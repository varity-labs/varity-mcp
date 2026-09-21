import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse } from "../utils/responses.js";
import { execCLI } from "../utils/cli-bridge.js";
import { INFRASTRUCTURE, isAuthenticated } from "../utils/config.js";

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
        "Credentials are never accepted as MCP tool input; enter the deploy key only in the hidden prompt from `varitykit auth login` in a trusted terminal.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (await isAuthenticated()) {
        return configuredCredentialResponse();
      }

      const settingsUrl = `${INFRASTRUCTURE.DEVELOPER_PORTAL}/dashboard/settings`;
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
        "Open a trusted terminal and run `varitykit auth login`; paste the deploy key only into its hidden prompt, then run varity_doctor.";
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
