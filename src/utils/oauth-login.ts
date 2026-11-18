/**
 * Browser and device sign-in for the local MCP (PLAN N3, IF-OAUTH; d1-auth §3.1, §3.4, §3.6).
 *
 * The MCP is the pre-registered public client `varity-mcp-local` of the
 * Varity authorization server (issuer `https://varity.app`, endpoints under
 * `/api/oauth/*`):
 *
 *   - default: authorization code + PKCE S256 through a single-use listener on
 *     `http://127.0.0.1:<random port>/callback` (RFC 8252);
 *   - headless (SSH, CI, Linux without a display): RFC 8628 device flow.
 *
 * Either way the token endpoint returns an ordinary owner-scoped `vk_` deploy
 * key (`access_token`) and its `key_id`, with no refresh token. The key leaves
 * this module only inside the returned `Grant`; it is never logged or shown.
 * The same contract as varitykit's `services/oauth_login.py` (row A4).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export const CLIENT_ID = "varity-mcp-local";
const SCOPE = "deploy";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** The server's authorization request lifetime (IF-OAUTH: request 600 s). */
export const REQUEST_LIFETIME_MS = 600_000;
const SLOW_DOWN_STEP_S = 5; // RFC 8628 §3.5
const HTTP_TIMEOUT_MS = 30_000;
const TRANSIENT_ERRORS = new Set(["temporarily_unavailable", "server_error"]);

/** Sign-in did not produce a key; the message is plain and safe to show. */
export class LoginError extends Error {
  constructor(message: string, readonly code: string = "SIGN_IN_FAILED") {
    super(message);
    this.name = "LoginError";
  }
}

export interface Grant {
  readonly deployKey: string;
  readonly deployKeyId: string | null;
}

/** True when no local browser can reach a loopback listener (d1-auth §3.1). */
export function isHeadless(env: NodeJS.ProcessEnv, platform: string = process.platform): boolean {
  if (env["SSH_CONNECTION"] || env["CI"] || env["HEADLESS"] === "true") return true;
  return platform === "linux" && !(env["DISPLAY"] || env["WAYLAND_DISPLAY"]);
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636: a 86-char verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier, "ascii").digest()) };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const UNAVAILABLE =
  "Browser sign-in to Varity isn't available right now, so nothing was changed on this computer.";

async function request(
  url: string,
  init: { method: "GET" | "POST"; form?: Record<string, string>; bearer?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers,
      body: init.form ? new URLSearchParams(init.form).toString() : undefined,
      redirect: "manual", // a 3xx is an answer: the bearer is never replayed elsewhere
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new LoginError(`Can't reach Varity at ${new URL(url).origin}. Check the internet connection, then try again.`, "VARITY_UNREACHABLE");
  }
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return {
    status: response.status,
    body: body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
  };
}

function errorOf(body: Record<string, unknown>): string {
  return typeof body["error"] === "string" ? body["error"] : "server_error";
}

function grantOf(body: Record<string, unknown>): Grant {
  const key = body["access_token"];
  const id = body["key_id"];
  if (typeof key !== "string" || !key) {
    throw new LoginError("Varity's sign-in answer had no key. Please try again.");
  }
  return { deployKey: key, deployKeyId: typeof id === "string" && id ? id : null };
}

/**
 * RFC 8414 discovery as a gate: the authorization server must name exactly
 * this issuer, advertise PKCE S256 and the device endpoint. Anything else
 * (404 before the server is live, an outage, a different issuer) stops sign-in
 * before a browser tab or code is shown.
 */
export async function checkAuthorizationServer(baseUrl: string): Promise<void> {
  let answer: { status: number; body: Record<string, unknown> };
  try {
    answer = await request(`${baseUrl}/.well-known/oauth-authorization-server`, { method: "GET" });
  } catch {
    throw new LoginError(UNAVAILABLE, "SIGN_IN_UNAVAILABLE");
  }
  const { status, body } = answer;
  const methods = body["code_challenge_methods_supported"];
  if (
    status !== 200 ||
    body["issuer"] !== baseUrl ||
    !Array.isArray(methods) ||
    !methods.includes("S256") ||
    typeof body["device_authorization_endpoint"] !== "string"
  ) {
    throw new LoginError(UNAVAILABLE, "SIGN_IN_UNAVAILABLE");
  }
  // The gateway serves the metadata statically, so it can answer while the
  // endpoints are still off. A grant-less token request has no side effect:
  // a live server refuses it with an RFC 6749 error, an absent one with 404.
  let probe: { status: number; body: Record<string, unknown> };
  try {
    probe = await request(`${baseUrl}/api/oauth/token`, { method: "POST", form: {} });
  } catch {
    throw new LoginError(UNAVAILABLE, "SIGN_IN_UNAVAILABLE");
  }
  if ((probe.status !== 400 && probe.status !== 401) || errorOf(probe.body) === "not_found") {
    throw new LoginError(UNAVAILABLE, "SIGN_IN_UNAVAILABLE");
  }
}

export interface LoopbackSignIn {
  /** The authorization URL the browser opens (holds no secret: the verifier stays here). */
  readonly url: string;
  readonly redirectUri: string;
  /** Settles with the key once the browser approval is redeemed. */
  readonly done: Promise<Grant>;
  /** Stop listening (idempotent). */
  readonly cancel: () => void;
}

const PAGE_OK = "Varity is connected. You can close this tab and go back to your AI assistant.";
const PAGE_FAILED = "Varity sign-in did not complete. Go back to your AI assistant for details.";

/** Authorization code + PKCE S256 through a single-use 127.0.0.1 listener. */
export async function startLoopbackSignIn(
  baseUrl: string,
  lifetimeMs: number = REQUEST_LIFETIME_MS
): Promise<LoopbackSignIn> {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(32));
  let resolveCallback!: (params: URLSearchParams | null) => void;
  const callback = new Promise<URLSearchParams | null>((resolve) => { resolveCallback = resolve; });

  const server: Server = createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || parsed.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    if (!sameSecret(parsed.searchParams.get("state") ?? "", state)) {
      // Not this sign-in's answer (a stray local request): ignore it and keep listening.
      res.writeHead(400).end();
      return;
    }
    const ok = parsed.searchParams.has("code") && !parsed.searchParams.has("error");
    const page = `<!doctype html><meta charset="utf-8"><title>Varity</title><p>${ok ? PAGE_OK : PAGE_FAILED}</p>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
    server.close(); // single use: stop accepting at once; the page below still completes
    res.end(page, () => close());
    resolveCallback(parsed.searchParams);
  });
  server.requestTimeout = 10_000; // a silent local connection cannot hold the listener
  const close = () => {
    if (server.listening) server.close();
    server.closeIdleConnections?.();
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref(); // never keeps the MCP process alive on its own
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = `${baseUrl}/api/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: SCOPE,
  }).toString()}`;

  const timer = setTimeout(() => resolveCallback(null), lifetimeMs);
  timer.unref();
  const cancel = () => {
    clearTimeout(timer);
    close();
    resolveCallback(null);
  };

  const done = (async (): Promise<Grant> => {
    const params = await callback;
    clearTimeout(timer);
    close();
    if (params === null) {
      throw new LoginError("The browser sign-in expired before it was confirmed. Call varity_login to start again.", "SIGN_IN_EXPIRED");
    }
    if (params.get("iss") !== baseUrl) { // RFC 9207: the server always names itself
      throw new LoginError("Sign-in was refused: the answer did not come from Varity.");
    }
    const error = params.get("error");
    if (error === "access_denied") throw new LoginError("Sign-in was declined in the browser.", "SIGN_IN_DENIED");
    if (error) throw new LoginError(`Sign-in did not complete (${error}). Call varity_login to try again.`);
    const code = params.get("code");
    if (!code) throw new LoginError("Sign-in did not complete: the browser answer had no code.");
    const { status, body } = await request(`${baseUrl}/api/oauth/token`, {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      },
    });
    if (status !== 200) {
      throw new LoginError(`Varity did not accept the sign-in (${errorOf(body)}). Call varity_login to try again.`);
    }
    return grantOf(body);
  })();
  done.catch(() => undefined); // observed by the caller; never an unhandled rejection
  return { url, redirectUri, done, cancel };
}

export interface DeviceSignIn {
  readonly verificationUri: string;
  readonly verificationUriComplete: string | null;
  readonly userCode: string;
  readonly done: Promise<Grant>;
  readonly cancel: () => void;
}

export interface DeviceOptions {
  label?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** RFC 8628: start a device authorization; `done` polls the token endpoint. */
export async function startDeviceSignIn(baseUrl: string, options: DeviceOptions = {}): Promise<DeviceSignIn> {
  const sleep = options.sleep ?? unrefSleep;
  const now = options.now ?? Date.now;
  const form: Record<string, string> = { client_id: CLIENT_ID, scope: SCOPE };
  // eslint-disable-next-line no-control-regex
  const label = (options.label ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64);
  if (label) form["requester_label"] = label;
  const start = await request(`${baseUrl}/api/oauth/device_authorization`, { method: "POST", form });
  const deviceCode = start.body["device_code"];
  const verificationUri = start.body["verification_uri"];
  const userCode = start.body["user_code"];
  if (start.status !== 200 || typeof deviceCode !== "string" || typeof verificationUri !== "string" || typeof userCode !== "string") {
    throw new LoginError(UNAVAILABLE, "SIGN_IN_UNAVAILABLE");
  }
  const complete = start.body["verification_uri_complete"];
  let cancelled = false;
  const deadline = now() + positiveSeconds(start.body["expires_in"], REQUEST_LIFETIME_MS / 1000) * 1000;
  let interval = positiveSeconds(start.body["interval"], SLOW_DOWN_STEP_S);

  const done = (async (): Promise<Grant> => {
    while (!cancelled && now() < deadline) {
      await sleep(interval * 1000);
      if (cancelled) break;
      let answer: { status: number; body: Record<string, unknown> };
      try {
        answer = await request(`${baseUrl}/api/oauth/token`, {
          method: "POST",
          form: { grant_type: DEVICE_GRANT, client_id: CLIENT_ID, device_code: deviceCode },
        });
      } catch {
        continue; // transient: the user may already have approved; keep polling until the deadline
      }
      const { status, body } = answer;
      if (status === 200) return grantOf(body);
      const error = errorOf(body);
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        const served = body["interval"];
        interval = Math.max(interval + SLOW_DOWN_STEP_S, typeof served === "number" ? served : 0);
        continue;
      }
      if (status === 429 || status >= 500 || TRANSIENT_ERRORS.has(error)) continue;
      if (error === "access_denied") throw new LoginError("Sign-in was declined in the browser.", "SIGN_IN_DENIED");
      if (error === "expired_token") break;
      throw new LoginError(`Sign-in did not complete (${error}). Call varity_login to try again.`);
    }
    throw new LoginError("The sign-in code expired before it was confirmed. Call varity_login to get a new code.", "SIGN_IN_EXPIRED");
  })();
  done.catch(() => undefined);
  return {
    verificationUri,
    verificationUriComplete: typeof complete === "string" ? complete : null,
    userCode,
    done,
    cancel: () => { cancelled = true; },
  };
}

/**
 * Revoke the presented key on Varity (`POST /api/keys/current/revoke`; a key
 * can revoke only itself). True on 2xx (revoked, or already). False on
 * 401/403: the route refused the bearer, which alone does not prove the key is
 * dead, so callers confirm against the API. Throws when the outcome is unknown.
 */
export async function revokeCurrentKey(baseUrl: string, deployKey: string): Promise<boolean> {
  const { status } = await request(`${baseUrl}/api/keys/current/revoke`, { method: "POST", form: {}, bearer: deployKey });
  if (status >= 200 && status < 300) return true;
  if (status === 401 || status === 403) return false;
  if (status === 404) throw new LoginError("Signing out through Varity isn't available yet.", "REVOKE_UNAVAILABLE");
  throw new LoginError(`Varity could not revoke the key right now (HTTP ${status}).`, "REVOKE_UNAVAILABLE");
}
