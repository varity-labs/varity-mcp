/**
 * The one HTTP client for every Varity Cloud call the MCP makes.
 *
 * Every read and every lifecycle mutation (deployments and CPU machines) goes
 * through `publicApiRequest`, so auth (the credential of the current call),
 * the User-Agent, the timeout and error shape exist once. The
 * gateway attributes a create by its body `source` field
 * (`deploymentOperationSurfaceForCreate`), so `createDeployment` sets
 * `source: "mcp"`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { INFRASTRUCTURE } from "./endpoints.js";

const PACKAGE_VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

/** Returns the upstream public-API bearer for the current call, or null (not signed in). */
export type CredentialProvider = () => Promise<string | null>;

/**
 * What one tool call runs with (IF-SERVER-FACTORY). `createVarityServer`
 * binds it around every tool callback through `runInCallContext`, so two
 * concurrent calls from different users (hosted mount) never share a
 * credential or client identity.
 */
export interface CallContext {
  credentials: CredentialProvider;
  transport: "stdio" | "streamable_http";
  /** The MCP client's `initialize` identity. */
  clientInfo: () => { name?: string; version?: string } | undefined;
}

const callContext = new AsyncLocalStorage<CallContext>();

export function runInCallContext<T>(context: CallContext, fn: () => T): T {
  return callContext.run(context, fn);
}

/**
 * Outside a bound call (direct library use) the stdio deploy-key order
 * applies. `config.ts` reads the filesystem, so it is loaded only here, never
 * by a remote call: a remote server always binds its own provider.
 */
const stdioCredentials: CredentialProvider = async () => (await import("./config.js")).getApiKey();

function currentCall(): CallContext {
  return callContext.getStore() ?? { credentials: stdioCredentials, transport: "stdio", clientInfo: () => undefined };
}

/** The current call's deploy key (for redacting it from passed-on text), or null. */
export async function currentCredential(): Promise<string | null> {
  return currentCall().credentials().catch(() => null);
}

/** A hosted (remote) call: copy names no local setup, link or purchase step. */
export function isRemoteCall(): boolean {
  return currentCall().transport === "streamable_http";
}

/** A bounded, low-cardinality token: no spaces, parentheses, separators or private text. */
function uaToken(value: string | undefined): string {
  const token = (value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return token || "unknown";
}

/** A distribution slug (vocabulary N16, owner conversion-funnel); anything else is dropped. */
const DISTRIBUTION_SLUG = /^[a-z0-9-]{1,32}$/;

/**
 * `varity-mcp/<version> (<client>/<client version>; transport=<stdio|streamable_http>[; dist=<slug>])`
 * (IF-CLIENT-ORIGIN). `dist` comes from `VARITY_DISTRIBUTION`, which a plugin
 * manifest sets for its stdio server; a hosted call is attributed by its
 * OAuth client instead, so it never carries one. Attribution only:
 * `source: "mcp"` on create stays canonical, and no key, path, repository or
 * account value is ever part of it.
 */
export function userAgent(): string {
  const call = currentCall();
  const client = call.clientInfo();
  const distribution = process.env["VARITY_DISTRIBUTION"] ?? "";
  const dist = call.transport === "stdio" && DISTRIBUTION_SLUG.test(distribution) ? `; dist=${distribution}` : "";
  return `varity-mcp/${PACKAGE_VERSION} (${uaToken(client?.name)}/${uaToken(client?.version)}; transport=${call.transport}${dist})`;
}

export class VarityPublicApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly action?: string,
    /** Extra served fields of a refusal (e.g. `profiles` on `profile_unknown`). */
    public readonly served?: Record<string, unknown>
  ) {
    super(message);
    this.name = "VarityPublicApiError";
  }
}

export const BILLING_URL = `${INFRASTRUCTURE.DASHBOARD}/billing`;
/** Where the portal's "Create deploy key" button lives; the portal calls these keys "deploy keys". */
export const DEPLOY_KEY_URL = `${INFRASTRUCTURE.DASHBOARD}/settings?tab=api-keys`;
/**
 * The one sign-in remedy: no key (doctor), a rejected key and an unauthenticated
 * call all say it. It is true whether or not browser sign-in is switched on:
 * varity_login opens the browser when it is, and answers SIGN_IN_UNAVAILABLE
 * when it is not, and then the deploy key is the way in (J-21, T2).
 */
export const DEPLOY_KEY_ACTION =
  "Call varity_login to connect. If browser sign-in is switched on, it opens a browser tab and the user confirms there. " +
  "If it answers SIGN_IN_UNAVAILABLE, tell the user: \"Browser sign-in isn't available right now. You can connect with a deploy key instead: " +
  `create one at ${DEPLOY_KEY_URL} and add it as VARITY_DEPLOY_KEY in your editor's MCP settings. Keep the key out of the chat.\"`;
/** A hosted call signs in through the host's connector, not a local key. */
const REMOTE_SIGN_IN_ACTION = "Reconnect the Varity connector in this app to sign in again, then retry.";

function signInAction(): string {
  return isRemoteCall() ? REMOTE_SIGN_IN_ACTION : DEPLOY_KEY_ACTION;
}

/**
 * MCP copy for billing refusals, keyed by the closed codes the owner serves in
 * `GET /api/pricing` (`credit_policy.errorCodes`). The served list decides which
 * codes are billing refusals; a served code without copy here gets
 * `BILLING_FALLBACK`. Codes are the owner's API identifiers and pass through
 * unchanged; the copy speaks USD only (founder ruling 2026-10-19: credits are
 * removed) and states no amount.
 */
const BILLING_COPY: Readonly<Record<string, { message: string; action: string }>> = {
  insufficient_credits: {
    message: "Your Varity balance is too low for this request.",
    action: `Add funds at ${BILLING_URL}, then retry.`,
  },
  daily_free_limit_reached: {
    message: "You have used today's free allowance.",
    action: `Wait for the daily reset, or add funds at ${BILLING_URL} to continue now.`,
  },
  spending_limit_reached: {
    message: "Your monthly spending limit on Varity has been reached.",
    action: `Raise the limit at ${BILLING_URL}, or wait for the next month.`,
  },
  subscription_required: {
    message: "This request needs an active Varity plan.",
    action: `Choose a plan at ${BILLING_URL}, then retry.`,
  },
  wallet_frozen: {
    message: "Billing on this Varity account is frozen, so new charges are refused.",
    action: "Contact Varity support to restore billing on the account.",
  },
  payment_method_shared: {
    message: "This payment method is already used by another Varity account, so the free allowance does not apply.",
    action: `Add a different payment method or add funds at ${BILLING_URL}.`,
  },
  quote_expired: {
    message: "The price quote expired before the request was confirmed.",
    action: "Retry the request to get a fresh quote.",
  },
  billing_unavailable: {
    message: "Varity billing is temporarily unavailable, so the request could not be checked.",
    action: "Retry in a few minutes.",
  },
};
const BILLING_FALLBACK = {
  message: "Varity billing refused this request.",
  action: `Check your plan and balance at ${BILLING_URL}.`,
};

/**
 * Hosted copy: explain only. No link and no purchase verb (a chat host may
 * not carry checkout); the account is funded outside the chat.
 */
const OUTSIDE_CHAT = "This is managed in the user's Varity account, outside this chat.";
const REMOTE_BILLING_ACTIONS: Readonly<Record<string, string>> = {
  insufficient_credits: `${OUTSIDE_CHAT} Retry once the balance covers the request.`,
  daily_free_limit_reached: "Retry after the daily reset.",
  spending_limit_reached: `${OUTSIDE_CHAT} Retry next month or once the limit changes.`,
  subscription_required: `${OUTSIDE_CHAT} Retry once a plan is active.`,
  wallet_frozen: "Contact Varity support to restore billing on the account.",
  payment_method_shared: OUTSIDE_CHAT,
  quote_expired: "Retry the request to get a fresh quote.",
  billing_unavailable: "Retry in a few minutes.",
};
/**
 * A deploy that admission declined for billing (`outcome.code` `billing_declined`),
 * keyed by its `diagnostic_code` (deploy-api `BILLING_DECLINE_OUTCOME_BY_REASON`):
 * the reason without its closing period, and what to do next. A hosted call
 * gets the hosted action (no link, no purchase step).
 */
const BILLING_DECLINE_COPY: Readonly<Record<string, string>> = {
  insufficient_prepaid_balance: "insufficient_credits",
  prepaid_monthly_limit_reached: "spending_limit_reached",
  prepaid_balance_frozen: "wallet_frozen",
  payment_method_shared: "payment_method_shared",
};
export function billingDeclineCopy(diagnosticCode: unknown): { why: string; action: string } {
  const code = typeof diagnosticCode === "string" && Object.hasOwn(BILLING_DECLINE_COPY, diagnosticCode)
    ? BILLING_DECLINE_COPY[diagnosticCode]
    : null;
  if (code) {
    return {
      why: BILLING_COPY[code].message.replace(/\.$/, ""),
      action: isRemoteCall() ? REMOTE_BILLING_ACTIONS[code] ?? OUTSIDE_CHAT : BILLING_COPY[code].action,
    };
  }
  if (diagnosticCode === "payment_method_required") {
    return {
      why: "Varity needs a payment method on file before it can run this app",
      action: isRemoteCall() ? OUTSIDE_CHAT : `Add a payment method at ${BILLING_URL}, then deploy again.`,
    };
  }
  return {
    why: "Varity billing declined this deploy",
    action: isRemoteCall() ? OUTSIDE_CHAT : BILLING_FALLBACK.action,
  };
}
/** A served text a hosted call may not pass on: a link or a purchase step. */
const PURCHASE_TEXT = /https?:\/\/|\/billing|\b(?:add funds|top up|choose a plan|upgrade|buy|purchase|subscribe)\b/i;

/**
 * The closed billing refusal codes served in `GET /api/pricing`
 * (`credit_policy.errorCodes`, owner: billing-meter), read per use: refusals
 * are rare and an uncached read never serves a stale list. `null` means
 * unavailable; callers then leave the error unchanged and never substitute a
 * local list. Nothing else is read from that block.
 */
export async function getBillingErrorCodes(): Promise<readonly string[] | null> {
  try {
    const data = await sendRequest<{ credit_policy?: { errorCodes?: unknown } | null }>(
      "GET", "/api/pricing", { anonymous: true }
    );
    const codes = data.credit_policy?.errorCodes;
    return Array.isArray(codes) && codes.every((code) => typeof code === "string") ? codes : null;
  } catch {
    return null;
  }
}

/** A 402/503 whose code the owner lists as a billing refusal gets MCP copy; anything else is unchanged. */
async function withBillingCopy(err: VarityPublicApiError): Promise<VarityPublicApiError> {
  if (err.status !== 402 && err.status !== 503) return err;
  const codes = await getBillingErrorCodes();
  const listed = codes?.includes(err.code) === true;
  if (!isRemoteCall()) {
    if (!listed) return err;
    const copy = Object.hasOwn(BILLING_COPY, err.code) ? BILLING_COPY[err.code] : BILLING_FALLBACK;
    return new VarityPublicApiError(copy.message, err.code, err.status, copy.action);
  }
  // Hosted: explain only. A listed code (or any 402, which is always a payment
  // refusal, even when the list is unreadable) gets the remote copy; any other
  // served text that carries a link or purchase step is replaced, never passed on.
  if (listed || err.status === 402) {
    const message = Object.hasOwn(BILLING_COPY, err.code) ? BILLING_COPY[err.code].message : BILLING_FALLBACK.message;
    const action = Object.hasOwn(REMOTE_BILLING_ACTIONS, err.code) ? REMOTE_BILLING_ACTIONS[err.code] : OUTSIDE_CHAT;
    return new VarityPublicApiError(message, err.code, err.status, action);
  }
  const message = PURCHASE_TEXT.test(err.message) ? BILLING_FALLBACK.message : err.message;
  const action = err.action && PURCHASE_TEXT.test(err.action) ? OUTSIDE_CHAT : err.action;
  return new VarityPublicApiError(message, err.code, err.status, action, err.served);
}

/**
 * A served action that names a raw HTTP route (`GET /api/...`) is an
 * instruction an MCP agent cannot follow: the agent calls tools, not routes.
 * Such an action is dropped so the calling tool's own tool-naming action is
 * used instead (journey D 2026-10-20, step 7/M3).
 */
const RAW_ROUTE = /\b(?:GET|POST|PATCH|PUT|DELETE)\s+\/api\//;
function agentAction(action: string | undefined): string | undefined {
  return action && RAW_ROUTE.test(action) ? undefined : action;
}

export interface PublicDeployment {
  /** The served row id: the operation id until the app is live, then its registry id. */
  id: string;
  /** The durable operation id, stable for the deployment's whole life (null on legacy rows). */
  operation_deployment_id?: string | null;
  app_name?: string;
  appName?: string;
  subdomain?: string;
  status?: string;
  runtime?: string;
  public_url?: string;
  url?: string;
  created_at?: string;
  createdAt?: string;
  updated_at?: string | null;
  updatedAt?: string | null;
  billing?: Record<string, unknown> | null;
}

export interface PublicLogLine {
  seq?: number;
  stream?: string;
  message?: string;
  created_at?: string;
}

export const PUBLIC_API_GET_TIMEOUT_MS = 60_000;

/** With `optional`, no configured key means an anonymous request instead of NOT_AUTHENTICATED. */
async function authHeaders(optional = false): Promise<Record<string, string>> {
  const key = await currentCall().credentials();
  if (!key && optional) return { Accept: "application/json" };
  if (!key) {
    throw new VarityPublicApiError(
      "Not authenticated with Varity.",
      "NOT_AUTHENTICATED",
      401,
      signInAction()
    );
  }
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
}

export interface PublicApiRequestOptions {
  body?: unknown;
  /** Sent as `Idempotency-Key`; machine mutations require one. */
  idempotencyKey?: string;
  /** A public read (no auth): sent without a key, so it works before sign-in. */
  anonymous?: boolean;
  /** A public read that carries the key when one is configured, else is anonymous. */
  keyOptional?: boolean;
  /** A binary body sent as is (in place of `body`), with its content type. */
  raw?: { data: Uint8Array; contentType: string };
  /** Overrides `PUBLIC_API_GET_TIMEOUT_MS` (an upload of a large archive). */
  timeoutMs?: number;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One HTTP exchange; every failure is a `VarityPublicApiError` carrying the served code. */
async function sendRequest<T>(
  method: HttpMethod,
  path: string,
  options: PublicApiRequestOptions = {}
): Promise<T> {
  const headers: Record<string, string> = options.anonymous
    ? { Accept: "application/json" }
    : await authHeaders(options.keyOptional);
  headers["User-Agent"] = userAgent();
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.raw) headers["Content-Type"] = options.raw.contentType;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? PUBLIC_API_GET_TIMEOUT_MS);
  try {
    const res = await fetch(`${INFRASTRUCTURE.GATEWAY}${path}`, {
      method,
      headers,
      body: (options.raw ? options.raw.data : options.body === undefined ? undefined : JSON.stringify(options.body)) as BodyInit | undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const body = data as { code?: string; error?: unknown; message?: string; action?: string };
      // Some services answer `{error: "<code>"}`; a snake_case token is a code, prose is not.
      const errorCode = typeof body.error === "string" && /^[a-z][a-z0-9_]*$/.test(body.error) ? body.error : undefined;
      const code = body.code ?? errorCode ?? "VARITY_API_ERROR";
      // The served key wording ("API key", no URL) is not the portal's term.
      const badKey = code === "invalid_api_key";
      const action = badKey ? signInAction() : agentAction(body.action);
      const prose = typeof body.error === "string" && !errorCode ? body.error : undefined;
      throw new VarityPublicApiError(
        badKey ? "The deploy key is invalid or revoked." : body.message ?? prose ?? `Varity API returned ${res.status}.`,
        code,
        res.status,
        action,
        data as Record<string, unknown>
      );
    }
    return data as T;
  } catch (err) {
    if (err instanceof VarityPublicApiError) throw err;
    throw new VarityPublicApiError(
      "Could not reach the Varity API.",
      "VARITY_API_UNREACHABLE",
      undefined,
      "Check your connection and retry."
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function publicApiRequest<T>(
  method: HttpMethod,
  path: string,
  options: PublicApiRequestOptions = {}
): Promise<T> {
  try {
    return await sendRequest<T>(method, path, options);
  } catch (err) {
    throw err instanceof VarityPublicApiError ? await withBillingCopy(err) : err;
  }
}

export async function publicApiGet<T>(path: string): Promise<T> {
  return publicApiRequest<T>("GET", path);
}

export async function listDeployments(): Promise<PublicDeployment[]> {
  const data = await publicApiGet<{ deployments?: PublicDeployment[] }>("/api/deployments");
  return Array.isArray(data.deployments) ? data.deployments : [];
}

export async function getDeployment(id: string): Promise<PublicDeployment> {
  const data = await publicApiGet<{ deployment?: PublicDeployment }>(
    `/api/deployments/${encodeURIComponent(id)}`
  );
  if (!data.deployment) {
    throw new VarityPublicApiError(
      "Deployment not found.",
      "DEPLOYMENT_NOT_FOUND",
      404,
      "Check the deployment id or app slug."
    );
  }
  return data.deployment;
}

export interface DeploymentLogsResult {
  lines: PublicLogLine[];
  count: number;
  /**
   * The public API reports `complete: false` when the returned window may be
   * partial — e.g. the live runtime source was momentarily unavailable. Absent
   * on older gateways; treat `undefined` as "not reported".
   */
  complete?: boolean;
  /** ISO timestamp of the live runtime read, when the gateway captured one. */
  observed_at?: string | null;
  /** Stable warning code present only alongside `complete: false`. */
  warning_code?: string;
}

export async function getDeploymentLogs(
  id: string,
  limit: number
): Promise<DeploymentLogsResult> {
  return publicApiGet<DeploymentLogsResult>(
    `/api/deployments/${encodeURIComponent(id)}/logs?limit=${encodeURIComponent(String(limit))}`
  );
}

/** A deployment or machine locator: its id, or (deployments only) its slug. */
function deploymentPath(deployment: string, suffix = ""): string {
  return `/api/deployments/${encodeURIComponent(deployment)}${suffix}`;
}

/** 202 acceptance of a durable lifecycle operation; follow it with `getRun`. */
export interface PublicRunAcceptance {
  run_id?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * One create through an `Idempotency-Key` generated per call (never derived
 * from the request: REGRESSIONS-LEDGER R839). A 504
 * `deploy_acceptance_unconfirmed` means the gateway cannot tell whether the
 * create was accepted; exactly one resend with the same key returns the
 * existing operation and never starts a second one (gateway #857); the served
 * `idempotency_key` is used when present. Any other
 * failure, or a second 504, is returned unchanged.
 */
async function idempotentCreate<T>(path: string, body: unknown, keyPrefix: string): Promise<T> {
  const idempotencyKey = `${keyPrefix}:${randomUUID()}`;
  try {
    return await publicApiRequest<T>("POST", path, { body, idempotencyKey });
  } catch (err) {
    if (!(err instanceof VarityPublicApiError && err.status === 504 && err.code === "deploy_acceptance_unconfirmed")) {
      throw err;
    }
    // The gateway names the key it holds the create under; it equals ours.
    const served = err.served?.idempotency_key;
    return publicApiRequest<T>("POST", path, {
      body,
      idempotencyKey: typeof served === "string" && served ? served : idempotencyKey,
    });
  }
}

/**
 * `POST /api/deployments`. The body is the public create contract (repo_url,
 * image, template_id, hosting, env, ...) passed through unchanged; `source`
 * is always `mcp` so the operation is attributed to this surface.
 */
export async function createDeployment(request: Record<string, unknown>): Promise<PublicRunAcceptance> {
  return idempotentCreate<PublicRunAcceptance>(
    "/api/deployments", { ...request, source: "mcp" }, "mcp-deploy"
  );
}

/** IF-UPLOAD: a pending, owner-bound upload slot (gateway U-5; unused slots expire after 1 h). */
export interface UploadSourceSlot {
  source_id: string;
  upload_url: string;
  upload_method?: string;
  max_bytes: number;
  expires_at: string;
}

/** `POST /api/deployments/sources` — 201 {source_id, upload_url, max_bytes, expires_at}. */
export async function createUploadSource(): Promise<UploadSourceSlot> {
  const slot = await publicApiRequest<Partial<UploadSourceSlot>>("POST", "/api/deployments/sources", {
    body: { format: "tar.gz" },
  });
  if (
    typeof slot.source_id !== "string" ||
    typeof slot.upload_url !== "string" ||
    // Only the gateway's own streaming PUT carries the key; never send it elsewhere.
    !slot.upload_url.startsWith("/api/") ||
    typeof slot.max_bytes !== "number"
  ) {
    throw new VarityPublicApiError(
      "Varity answered the upload request in a form this MCP version does not understand.",
      "upload_source_unrecognized",
      undefined,
      "Update the Varity MCP server, then retry."
    );
  }
  return slot as UploadSourceSlot;
}

/** Upload deadline: 50 MB on a slow uplink; the gateway's own whole-body deadline is shorter. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** `PUT <upload_url>` with the archive; 200 seals it. Refusals carry the served code. */
export async function uploadSourceArchive(slot: UploadSourceSlot, archive: Uint8Array): Promise<void> {
  const method = (slot.upload_method ?? "PUT").toUpperCase();
  await publicApiRequest(method === "POST" ? "POST" : "PUT", slot.upload_url, {
    raw: { data: archive, contentType: "application/gzip" },
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

/** `POST /api/deployments` from a sealed upload source; attribution rides in `source.client`. */
export async function createUploadDeployment(
  request: Record<string, unknown>,
  sourceId: string
): Promise<PublicRunAcceptance> {
  return idempotentCreate<PublicRunAcceptance>(
    "/api/deployments",
    { ...request, source: { type: "upload", source_id: sourceId, client: "mcp" } },
    "mcp-deploy"
  );
}

/** `DELETE /api/deployments/:id` — 202 `{status:"deleting", run_id}` or 200 `{deleted:true}`. */
export async function deleteDeployment(
  deployment: string
): Promise<PublicRunAcceptance & { deleted?: boolean }> {
  return publicApiRequest("DELETE", deploymentPath(deployment));
}

/** `POST /api/deployments/:id/redeploy` — 202 `{run_id}`; keyed like a create. */
export async function redeploy(deployment: string): Promise<PublicRunAcceptance> {
  return idempotentCreate<PublicRunAcceptance>(deploymentPath(deployment, "/redeploy"), undefined, "mcp-redeploy");
}

/** `GET /api/templates` — the gateway-owned certified template catalog. */
export async function listTemplates<T>(): Promise<T[]> {
  const data = await publicApiGet<{ templates?: T[] }>("/api/templates");
  return Array.isArray(data.templates) ? data.templates : [];
}

/** `GET /api/templates/:id` — 404 `template_not_found` for an unknown or uncertified id. */
export async function getTemplate<T>(id: string): Promise<T> {
  const data = await publicApiGet<{ template?: T }>(`/api/templates/${encodeURIComponent(id)}`);
  if (!data.template) {
    throw new VarityPublicApiError("Template not found.", "template_not_found", 404);
  }
  return data.template;
}

/**
 * `POST /api/templates/:id/deploy` — 202 acceptance with `source: "mcp"`.
 * `env` (write-only on the gateway) carries the template's required values,
 * read on the user's machine; it is sent only when non-empty.
 */
export async function deployTemplate(id: string, name?: string, env?: Record<string, string>): Promise<PublicRunAcceptance> {
  return idempotentCreate<PublicRunAcceptance>(
    `/api/templates/${encodeURIComponent(id)}/deploy`,
    { ...(name ? { name } : {}), ...(env && Object.keys(env).length > 0 ? { env } : {}), source: "mcp" },
    "mcp-template-deploy"
  );
}

/**
 * `PATCH /api/deployments/:id/env` — merges the given values into the app's
 * write-only environment and RESTARTS it: 202 `{status: "redeploying",
 * run_id, env: {keys, count}}` (gateway `public-api.ts` env PATCH). Never sent
 * with `replace`, never retried here: the gateway mints its own idempotency key
 * per request, so a resend is a second restart.
 */
export async function updateDeploymentEnv(
  deployment: string,
  env: Record<string, string>
): Promise<PublicRunAcceptance & { env?: { keys?: string[]; count?: number } }> {
  return publicApiRequest("PATCH", deploymentPath(deployment, "/env"), { body: { env } });
}

/**
 * One run's sealed build error: `GET /api/deployments/runs/:runId/logs`
 * (gateway `public-api.ts` `buildLogBody`): `{lines, count, complete,
 * warning_code?, source: "build", stage, observed_at}`; 404
 * `build_log_not_found` when the run recorded none.
 */
export interface RunBuildLog {
  lines?: unknown;
  count?: number;
  complete?: boolean;
  stage?: string | null;
  observed_at?: string | null;
}

export async function getRunBuildLog(runId: string): Promise<RunBuildLog> {
  return publicApiGet<RunBuildLog>(`/api/deployments/runs/${encodeURIComponent(runId)}/logs`);
}

/**
 * The custom-domain claim the gateway serves (`CustomDomainRecord`, secret-free):
 * the DNS record to add comes from `recordType`/`recordName` and
 * `expectedCname` (subdomain) or `expectedA` + `challenge` (apex).
 */
export interface CustomDomainClaim {
  hostname?: string;
  recordType?: "cname" | "a";
  recordName?: string;
  expectedCname?: string;
  expectedA?: string;
  challenge?: { name?: string; value?: string };
  state?: string;
  dns?: { status?: string };
  certificate?: { status?: string };
  serving?: { status?: string };
  errorCode?: string;
}

export interface CustomDomainAnswer {
  supported?: boolean;
  domain?: CustomDomainClaim | null;
  removed?: boolean;
}

/** `PUT /api/deployments/:id/domain` `{hostname}` — 201 (new) or 200 (same hostname again). */
export async function attachCustomDomain(deployment: string, hostname: string): Promise<CustomDomainAnswer> {
  return publicApiRequest("PUT", deploymentPath(deployment, "/domain"), { body: { hostname } });
}

/** `POST /api/deployments/:id/domain/verify` — checks DNS now and returns the updated claim. */
export async function verifyCustomDomain(deployment: string): Promise<CustomDomainAnswer> {
  return publicApiRequest("POST", deploymentPath(deployment, "/domain/verify"));
}

/** `DELETE /api/deployments/:id/domain` — `{removed: true, domain: null}`. */
export async function removeCustomDomain(deployment: string): Promise<CustomDomainAnswer> {
  return publicApiRequest("DELETE", deploymentPath(deployment, "/domain"));
}

/**
 * `GET /api/deployments/runs/:runId` — the durable run view plus
 * `public_status`, `outcome`, `url`, `error_message`, `support_id`, `events`.
 */
export async function getRun(runId: string): Promise<Record<string, unknown>> {
  return publicApiGet<Record<string, unknown>>(
    `/api/deployments/runs/${encodeURIComponent(runId)}`
  );
}

/** `GET /api/machines` — `{machines}` plus inventory completeness fields when partial. */
export async function listMachines(): Promise<{
  machines: Record<string, unknown>[];
  inventory_status?: string;
  dropped_count?: number;
}> {
  const data = await publicApiGet<{
    machines?: Record<string, unknown>[];
    inventory_status?: string;
    dropped_count?: number;
  }>("/api/machines");
  return { ...data, machines: Array.isArray(data.machines) ? data.machines : [] };
}

/**
 * `POST /api/machines`. The gateway accepts exactly: name, profile_id,
 * execution_class, os_image (or custom_image_url + custom_image_username),
 * optional additional_storage_gb, ssh_public_key (the caller's PUBLIC key,
 * never a private one), and accelerator_quote_token from
 * `POST /api/pricing/machine-quote`.
 */
export async function createMachine(
  request: Record<string, unknown>,
  idempotencyKey: string = `mcp-machine-create:${randomUUID()}`
): Promise<PublicRunAcceptance> {
  return publicApiRequest<PublicRunAcceptance>("POST", "/api/machines", {
    body: request,
    idempotencyKey,
  });
}

/** `DELETE /api/machines/:id` — 202 acceptance; stops billing when the run completes. */
export async function deleteMachine(
  machineId: string,
  idempotencyKey: string = `mcp-machine-delete:${randomUUID()}`
): Promise<PublicRunAcceptance> {
  return publicApiRequest<PublicRunAcceptance>(
    "DELETE",
    `/api/machines/${encodeURIComponent(machineId)}`,
    { idempotencyKey }
  );
}

/**
 * Public `GET /api/pricing?profile=`: the pre-deploy estimate the portal deploy
 * page shows. It carries the deploy key when one is configured, so the owner
 * can price the caller's own account (e.g. its active static-site count); with
 * no key it stays anonymous and needs no sign-in. A rejected key is the
 * standard `invalid_api_key` refusal, never retried anonymously.
 */
export async function getPublicProfilePricing(profile: string | undefined): Promise<Record<string, unknown>> {
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  return sendRequest<Record<string, unknown>>("GET", `/api/pricing${qs}`, { keyOptional: true });
}
