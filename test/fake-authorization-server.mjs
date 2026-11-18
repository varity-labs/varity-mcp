/**
 * A fake Varity authorization server for the A5 sign-in tests (IF-OAUTH, PLAN N3).
 * It follows credential-proxy `oauth.py` and gateway `routes/oauth.ts` on
 * agent/dist-identity-20261117: RFC 8414 metadata at the issuer, endpoints
 * under `/api/oauth/*`, PKCE S256 only, single-use codes, loopback redirects
 * on any port, `iss` on the redirect, `key_id` beside the `vk_` access token,
 * and `POST /api/keys/current/revoke` for the presented key only.
 * Not a test file: `npm test` runs `test/*.mjs`, and this module defines no tests.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

function s256(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export async function startFakeAuthorizationServer() {
  const state = {
    live: true,
    endpointsLive: true, // false: metadata served (gateway static) but /api/oauth/* and revoke 404 (VARITY_OAUTH_ENABLED off)
    issuerOverride: null,
    requests: new Map(), // code -> request
    authorizeHits: [],
    tokenCalls: [],
    revokes: [],
    revokeStatus: 200,
    validKeys: new Set(),
    minted: 0,
    device: null, // { deviceCode, userCode, approved, denied, script: [] }
    deviceInterval: 1,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const mint = () => {
      state.minted += 1;
      const key = `vk_dev_fake${String(state.minted).padStart(4, "0")}`;
      state.validKeys.add(key);
      return { access_token: key, token_type: "Bearer", expires_in: 31_536_000, scope: "deploy", key_id: `key_${state.minted}` };
    };

    if (!state.live) return json(404, { error: "not_found" });

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: state.issuerOverride ?? base,
        authorization_endpoint: `${base}/api/oauth/authorize`,
        token_endpoint: `${base}/api/oauth/token`,
        device_authorization_endpoint: `${base}/api/oauth/device_authorization`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (!state.endpointsLive && (url.pathname.startsWith("/api/oauth/") || url.pathname === "/api/keys/current/revoke")) {
      return json(404, { error: "not_found" });
    }
    if (req.method === "GET" && url.pathname === "/api/oauth/authorize") {
      const q = url.searchParams;
      state.authorizeHits.push(Object.fromEntries(q));
      const redirect = new URL(q.get("redirect_uri"));
      if (
        q.get("client_id") !== "varity-mcp-local" || q.get("response_type") !== "code" ||
        q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "") ||
        redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/callback"
      ) return json(400, { error: "invalid_request" });
      const code = `vac_${state.authorizeHits.length}`;
      state.requests.set(code, { challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri"), state: q.get("state"), used: false });
      res.writeHead(302, { Location: `https://developer.store.varity.so/authorize/?request=${code}` });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/api/oauth/device_authorization") {
      if (form.get("client_id") !== "varity-mcp-local") return json(401, { error: "invalid_client" });
      state.device = { deviceCode: "vdc_fake", userCode: "BCDF-GHJK", approved: false, denied: false, script: state.device?.script ?? [], label: form.get("requester_label") };
      return json(200, {
        device_code: "vdc_fake", user_code: "BCDF-GHJK",
        verification_uri: "https://developer.store.varity.so/authorize/",
        verification_uri_complete: "https://developer.store.varity.so/authorize/?user_code=BCDF-GHJK",
        expires_in: 600, interval: state.deviceInterval,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/oauth/token") {
      state.tokenCalls.push(Object.fromEntries(form));
      // Like oauth.py token(): the grant type is checked before the client.
      if (!["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"].includes(form.get("grant_type"))) {
        return json(400, { error: "unsupported_grant_type" });
      }
      if (form.get("client_id") !== "varity-mcp-local") return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const request = state.requests.get(form.get("code"));
        if (!request || request.used || request.redirectUri !== form.get("redirect_uri") ||
            s256(form.get("code_verifier") ?? "") !== request.challenge) {
          return json(400, { error: "invalid_grant" });
        }
        request.used = true;
        return json(200, mint());
      }
      if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        const device = state.device;
        if (!device || form.get("device_code") !== device.deviceCode) return json(400, { error: "invalid_grant" });
        const scripted = device.script.shift();
        if (scripted) return json(scripted[0], scripted[1]);
        if (device.denied) return json(400, { error: "access_denied" });
        if (!device.approved) return json(400, { error: "authorization_pending" });
        state.device = null;
        return json(200, mint());
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (req.method === "POST" && url.pathname === "/api/keys/current/revoke") {
      state.revokeCalls = (state.revokeCalls ?? 0) + 1;
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      state.revokes.push(bearer);
      if (state.revokeStatus === 200) state.validKeys.delete(bearer);
      return json(state.revokeStatus, state.revokeStatus === 200 ? { revoked: true } : { detail: "refused" });
    }
    if (req.method === "GET" && url.pathname === "/api/deployments") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      return state.validKeys.has(bearer)
        ? json(200, { deployments: [] })
        : json(401, { code: "invalid_api_key", message: "The key is invalid or revoked." });
    }
    return json(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** What a browser does after the user confirms: follow the authorize URL, then hit the loopback redirect. */
  async function approveInBrowser(authorizeUrl, { stateOverride, iss } = {}) {
    const answer = await fetch(authorizeUrl, { redirect: "manual" });
    if (answer.status !== 302) throw new Error(`authorize refused: ${answer.status}`);
    const code = `vac_${state.authorizeHits.length}`;
    const request = state.requests.get(code);
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", stateOverride ?? request.state);
    redirect.searchParams.set("iss", iss ?? base);
    return fetch(redirect);
  }

  return { base, state, approveInBrowser, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
