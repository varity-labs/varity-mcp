import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { INFRASTRUCTURE } from "../utils/config.js";

const DEPLOY_OWNER_ROUTE = `Varity deployment guidance is owned by the live public documentation at ${INFRASTRUCTURE.DOCS}.

Use varity_search_docs for current setup, deployment, supported-stack, and troubleshooting guidance. Use varity_cost_calculator for current price estimates and varity_deploy_status for owner-scoped deployment state.

This compatibility resource intentionally does not copy mutable deployment instructions, prices, quotas, topology, or release state.`;

/**
 * Register Varity deploy resources.
 *
 * Preserve the public resource URI while routing mutable facts to live owners.
 */
export function registerResources(server: McpServer): void {
  server.resource(
    "deploy-reference",
    "varity://deploy/reference",
    {
      mimeType: "text/plain",
      description:
        "Stable route to Varity's live deployment documentation and executable owners",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: DEPLOY_OWNER_ROUTE },
      ],
    })
  );
}
