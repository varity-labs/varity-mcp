import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export type AuthenticatedHttpRequest = IncomingMessage & { auth?: AuthInfo };

function writeOAuthError(
  response: ServerResponse,
  status: 401 | 403,
  error: "invalid_token" | "insufficient_scope",
  description: string,
): void {
  response.setHeader(
    "WWW-Authenticate",
    `Bearer error="${error}", error_description="${description}"`,
  );
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error, error_description: description }));
}

/**
 * Authenticate one Streamable HTTP request before it reaches the MCP SDK.
 *
 * The validated AuthInfo is attached where the pinned SDK transport expects it,
 * so request handlers receive the verified principal without this module
 * deciding how individual hosted tools may use that principal.
 */
export async function authenticateBearerRequest(
  request: AuthenticatedHttpRequest,
  response: ServerResponse,
  verifier: OAuthTokenVerifier,
): Promise<AuthInfo | undefined> {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string"
    ? /^Bearer ([^\s]+)$/i.exec(authorization)
    : null;

  if (!match) {
    writeOAuthError(
      response,
      401,
      "invalid_token",
      "A valid Bearer access token is required",
    );
    return undefined;
  }

  try {
    const authInfo = await verifier.verifyAccessToken(match[1]!);
    request.auth = authInfo;
    return authInfo;
  } catch {
    writeOAuthError(
      response,
      401,
      "invalid_token",
      "The Bearer access token is invalid or expired",
    );
    return undefined;
  }
}

export function rejectSessionPrincipalMismatch(response: ServerResponse): void {
  writeOAuthError(
    response,
    403,
    "insufficient_scope",
    "The MCP session belongs to a different authenticated principal",
  );
}
