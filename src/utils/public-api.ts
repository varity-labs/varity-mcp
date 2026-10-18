/**
 * The one HTTP client for every Varity Cloud call the MCP makes.
 *
 * Every read and every lifecycle mutation (deployments and CPU machines) goes
 * through `publicApiRequest`, so auth (`VARITY_API_KEY ?? VARITY_DEPLOY_KEY`,
 * read by `getApiKey`), the timeout and error shape exist once. WHY: mutations used to shell to the `varitykit` CLI, which read a
 * different key and tagged every MCP deploy as `cli` (evidence p2-cli-mcp D10,
 * D11). The gateway attributes a create by its body `source` field
 * (`deploymentOperationSurfaceForCreate`), so `createDeployment` sets
 * `source: "mcp"`.
 */
import { randomUUID } from "node:crypto";
import { getApiKey, INFRASTRUCTURE } from "./config.js";

export class VarityPublicApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly action?: string
  ) {
    super(message);
    this.name = "VarityPublicApiError";
  }
}

const BILLING_URL = `${INFRASTRUCTURE.DASHBOARD}/billing`;

/**
 * MCP copy for billing refusals, keyed by the codes the owner serves in
 * `credit_policy.errorCodes`. The served list decides which codes are billing
 * refusals; a served code without copy here gets `BILLING_FALLBACK`.
 */
const BILLING_COPY: Readonly<Record<string, { message: string; action: string }>> = {
  insufficient_credits: {
    message: "Your Varity credit balance is too low for this request.",
    action: `Add credits at ${BILLING_URL}, then retry.`,
  },
  daily_free_limit_reached: {
    message: "You have used today's free allowance.",
    action: `Wait for the daily reset, or add credits at ${BILLING_URL} to continue now.`,
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
    action: `Add a different payment method or buy credits at ${BILLING_URL}.`,
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
  action: `Check your plan and credits at ${BILLING_URL}.`,
};

/** The `credit_policy` fields the MCP reads (owner: billing-meter `CREDIT_POLICY`). */
export interface CreditPolicy {
  version: string;
  creditsPerUsd: number;
  errorCodes: readonly string[];
}

function decodeCreditPolicy(raw: unknown): CreditPolicy | null {
  if (raw === null || typeof raw !== "object") return null;
  const { version, creditsPerUsd, errorCodes } = raw as Record<string, unknown>;
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof creditsPerUsd !== "number" || !Number.isInteger(creditsPerUsd) || creditsPerUsd <= 0) return null;
  if (!Array.isArray(errorCodes) || !errorCodes.every((code) => typeof code === "string")) return null;
  return { version, creditsPerUsd, errorCodes };
}

/**
 * `credit_policy` from `GET /api/pricing`, read per use (estimates and billing
 * refusals are rare, and an uncached read can never serve a stale policy).
 * `null` means unavailable: callers show that state and never substitute a
 * local rate or code list.
 */
export async function getCreditPolicy(): Promise<CreditPolicy | null> {
  try {
    const data = await sendRequest<{ credit_policy?: unknown }>("GET", "/api/pricing");
    return decodeCreditPolicy(data.credit_policy);
  } catch {
    return null;
  }
}

/** A 402/503 whose code the owner lists as a billing refusal gets MCP copy; anything else is unchanged. */
async function withBillingCopy(err: VarityPublicApiError): Promise<VarityPublicApiError> {
  if (err.status !== 402 && err.status !== 503) return err;
  const policy = await getCreditPolicy();
  if (!policy?.errorCodes.includes(err.code)) return err;
  const copy = Object.hasOwn(BILLING_COPY, err.code) ? BILLING_COPY[err.code] : BILLING_FALLBACK;
  return new VarityPublicApiError(copy.message, err.code, err.status, copy.action);
}

export interface PublicDeployment {
  id: string;
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

async function authHeaders(): Promise<Record<string, string>> {
  const key = await getApiKey();
  if (!key) {
    throw new VarityPublicApiError(
      "Not authenticated with Varity.",
      "NOT_AUTHENTICATED",
      401,
      "Run varity_login, then complete `varitykit auth login` in a trusted terminal."
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
}

/** One HTTP exchange; every failure is a `VarityPublicApiError` carrying the served code. */
async function sendRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: PublicApiRequestOptions = {}
): Promise<T> {
  const headers = await authHeaders();
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLIC_API_GET_TIMEOUT_MS);
  try {
    const res = await fetch(`${INFRASTRUCTURE.GATEWAY}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const body = data as { code?: string; error?: unknown; message?: string; action?: string };
      // Some services answer `{error: "<code>"}`; a snake_case token is a code, prose is not.
      const errorCode = typeof body.error === "string" && /^[a-z][a-z0-9_]*$/.test(body.error) ? body.error : undefined;
      throw new VarityPublicApiError(
        body.message ?? `Varity API returned ${res.status}.`,
        body.code ?? errorCode ?? "VARITY_API_ERROR",
        res.status,
        body.action
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
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
 * `POST /api/deployments`. The body is the public create contract (repo_url,
 * image, template_id, hosting, env, ...) passed through unchanged; `source`
 * is always `mcp` so the operation is attributed to this surface. An
 * `Idempotency-Key` is sent only when the caller passes one.
 */
export async function createDeployment(
  request: Record<string, unknown>,
  idempotencyKey?: string
): Promise<PublicRunAcceptance> {
  return publicApiRequest<PublicRunAcceptance>("POST", "/api/deployments", {
    body: { ...request, source: "mcp" },
    idempotencyKey,
  });
}

/** `DELETE /api/deployments/:id` — 202 `{status:"deleting", run_id}` or 200 `{deleted:true}`. */
export async function deleteDeployment(
  deployment: string
): Promise<PublicRunAcceptance & { deleted?: boolean }> {
  return publicApiRequest("DELETE", deploymentPath(deployment));
}

/** `POST /api/deployments/:id/redeploy` — 202 `{run_id}`. */
export async function redeploy(deployment: string): Promise<PublicRunAcceptance> {
  return publicApiRequest<PublicRunAcceptance>("POST", deploymentPath(deployment, "/redeploy"));
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
