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
      "Run varity_login with a Developer Portal deploy key."
    );
  }
  return { Authorization: `Bearer ${key}`, Accept: "application/json" };
}

export async function publicApiGet<T>(path: string): Promise<T> {
  const headers = await authHeaders();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLIC_API_GET_TIMEOUT_MS);
  try {
    const res = await fetch(`${INFRASTRUCTURE.GATEWAY}${path}`, {
      headers,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const body = data as { code?: string; message?: string; action?: string };
      throw new VarityPublicApiError(
        body.message ?? `Varity API returned ${res.status}.`,
        body.code ?? "VARITY_API_ERROR",
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
