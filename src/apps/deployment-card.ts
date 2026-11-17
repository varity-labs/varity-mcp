import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { DEPLOYMENT_CARD_HTML } from "./deployment-card-html.js";

/** The one MCP Apps resource; only `varity_show_deployment` points at it. */
export const DEPLOYMENT_CARD_URI = "ui://varity/deployment-card.html";

/** No external origin: every value arrives through the host bridge. */
const CARD_UI = { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } };

export function registerDeploymentCard(server: McpServer): void {
  registerAppResource(
    server,
    "Varity deployment card",
    DEPLOYMENT_CARD_URI,
    {
      description: "Shows a deployment's monthly price, status steps and live URL.",
      _meta: { ui: CARD_UI },
    },
    async () => ({
      contents: [{ uri: DEPLOYMENT_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: DEPLOYMENT_CARD_HTML, _meta: { ui: CARD_UI } }],
    })
  );
}
