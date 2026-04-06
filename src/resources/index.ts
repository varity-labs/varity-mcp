import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DATABASE_REFERENCE } from "./database.js";
import { AUTH_REFERENCE } from "./auth.js";
import { UI_COMPONENTS_REFERENCE } from "./ui-components.js";
import { PATTERNS_REFERENCE } from "./patterns.js";
import { DEPLOY_REFERENCE } from "./deploy.js";

/**
 * Register all Varity SDK resources.
 *
 * Resources provide persistent context to AI coding tools so they
 * can write correct Varity code without searching docs or guessing.
 */
export function registerResources(server: McpServer): void {
  server.resource(
    "database-api",
    "varity://sdk/database",
    {
      mimeType: "text/plain",
      description:
        "Complete Varity Database API — Collection CRUD, QueryOptions, Document types, React hook patterns",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: DATABASE_REFERENCE },
      ],
    })
  );

  server.resource(
    "auth-api",
    "varity://sdk/auth",
    {
      mimeType: "text/plain",
      description:
        "Complete Varity Authentication API — PrivyStack, usePrivy, ProtectedRoute, LoginButton, provider setup",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: AUTH_REFERENCE },
      ],
    })
  );

  server.resource(
    "ui-components",
    "varity://sdk/ui-components",
    {
      mimeType: "text/plain",
      description:
        "Complete Varity UI Kit — 52+ components with props, types, and usage examples",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: UI_COMPONENTS_REFERENCE,
        },
      ],
    })
  );

  server.resource(
    "app-patterns",
    "varity://sdk/patterns",
    {
      mimeType: "text/plain",
      description:
        "Canonical Varity app patterns — file structure, data chain, CRUD pages, auth wrapping, config",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: PATTERNS_REFERENCE },
      ],
    })
  );

  server.resource(
    "deploy-reference",
    "varity://sdk/deploy",
    {
      mimeType: "text/plain",
      description:
        "Varity deployment reference — varitykit deploy, auto-config, App Store, revenue split, costs",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: DEPLOY_REFERENCE },
      ],
    })
  );
}
