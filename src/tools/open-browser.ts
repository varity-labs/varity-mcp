import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { execCLI } from "../utils/cli-bridge.js";

export function registerOpenBrowserTool(server: McpServer): void {
  server.registerTool(
    "varity_open_browser",
    {
      title: "Open in Browser",
      description:
        "Open a URL in the user's default browser. " +
        "Use after deploying to show the live app or after starting the dev server.",
      inputSchema: {
        url: z
          .string()
          .url("Must be a valid URL (e.g., https://my-app.varity.app)")
          .describe("URL to open in the default browser"),
      },
    },
    async ({ url }) => {
      const platform = process.platform;
      let command: string;
      let args: string[];

      if (platform === "darwin") {
        command = "open";
        args = [url];
      } else if (platform === "win32") {
        command = "cmd.exe";
        args = ["/c", "start", url];
      } else {
        // Linux and other Unix-like systems
        command = "xdg-open";
        args = [url];
      }

      const result = await execCLI(command, args, { timeout: 10_000 });

      if (result.exitCode === 0) {
        return successResponse(
          {
            opened: true,
            url,
          },
          `Opened ${url} in the default browser.`
        );
      }

      const reason = (result.stderr || result.stdout || "").trim() || "Browser launcher exited with a non-zero status.";
      return errorResponse(
        "BROWSER_OPEN_FAILED",
        `Could not open browser automatically. Reason: ${reason.slice(0, 200)}`,
        `Open this URL manually: ${url}`
      );
    }
  );
}
