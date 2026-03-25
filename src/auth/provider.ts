/**
 * OAuth 2.0 provider for Varity MCP HTTP transport.
 *
 * In production, this proxies to Varity's auth infrastructure at auth.varity.so.
 * For local development, set VARITY_MCP_DEV_TOKEN to bypass OAuth.
 */

import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const AUTH_BASE = process.env["VARITY_AUTH_URL"] ?? "https://auth.varity.so";
const GATEWAY_URL = process.env["VARITY_GATEWAY_URL"] ?? "https://varity.app";

/**
 * In-memory client store for dynamic client registration.
 * In production this would be backed by a database.
 */
const registeredClients = new Map<string, OAuthClientInformationFull>();

/**
 * Verify an access token against the Varity gateway.
 * Returns auth info if valid, throws if invalid.
 */
async function verifyAccessToken(token: string): Promise<AuthInfo> {
  // Dev mode: accept any token matching VARITY_MCP_DEV_TOKEN
  const devToken = process.env["VARITY_MCP_DEV_TOKEN"];
  if (devToken && token === devToken) {
    return {
      token,
      clientId: "dev-client",
      scopes: ["read", "write", "deploy"],
    };
  }

  // Production: verify against gateway
  const res = await fetch(`${GATEWAY_URL}/api/auth/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Invalid or expired access token`);
  }

  const data = (await res.json()) as { user_id?: string; scopes?: string[] };
  return {
    token,
    clientId: data.user_id ?? "unknown",
    scopes: data.scopes ?? ["read", "write"],
  };
}

/**
 * Look up a registered OAuth client by ID.
 */
async function getClient(
  clientId: string
): Promise<OAuthClientInformationFull | undefined> {
  return registeredClients.get(clientId);
}

/**
 * Create the OAuth provider for the Varity MCP HTTP server.
 *
 * Uses the MCP SDK's ProxyOAuthServerProvider which handles:
 * - Authorization code flow (redirects to auth.varity.so)
 * - Token exchange
 * - Token refresh
 * - Dynamic client registration
 */
export function createOAuthProvider(): ProxyOAuthServerProvider {
  return new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: `${AUTH_BASE}/authorize`,
      tokenUrl: `${AUTH_BASE}/token`,
      revocationUrl: `${AUTH_BASE}/revoke`,
      registrationUrl: `${AUTH_BASE}/register`,
    },
    verifyAccessToken,
    getClient,
  });
}
