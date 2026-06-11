import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEPLOY_REFERENCE } from "./deploy.js";

/**
 * Register Varity deploy resources.
 *
 * Resources provide persistent context to AI coding tools so they can deploy
 * correctly without searching docs or guessing.
 */
export function registerResources(server: McpServer): void {
  server.resource(
    "deploy-reference",
    "varity://deploy/reference",
    {
      mimeType: "text/plain",
      description:
        "Varity deployment reference: how to deploy with varitykit, supported stacks, hosting, billing, and costs",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: DEPLOY_REFERENCE },
      ],
    })
  );
}
