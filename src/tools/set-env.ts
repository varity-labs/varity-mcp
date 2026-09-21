import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse } from "../utils/responses.js";

export function secureSetEnvRefusal() {
  return errorResponse(
    "SECURE_ENV_CONFIGURATION_REQUIRED",
    "varity_set_env remains available for client compatibility, but this MCP does not accept secret or configuration values as tool input.",
    "Configure environment variables through the Developer Portal or another approved secret-safe interface. Never place secret values in chat or MCP arguments."
  );
}

export function registerSetEnvTool(server: McpServer): void {
  server.registerTool(
    "varity_set_env",
    {
      annotations: { readOnlyHint: true },
      title: "Route Environment Configuration Safely",
      description:
        "Compatibility route for environment configuration. It never accepts values and directs private configuration to an approved secret-safe interface.",
      inputSchema: {},
    },
    async () => secureSetEnvRefusal()
  );
}
