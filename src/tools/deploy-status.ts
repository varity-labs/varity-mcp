import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  getDeployment,
  getRun,
  listDeployments,
  VarityPublicApiError,
  type PublicDeployment,
} from "../utils/public-api.js";

interface DeploymentRecord {
  /** The canonical id: the durable operation id `varity_deploy` returned, stable for the whole life. */
  id: string;
  /** Absent until the owner assigns one; never a placeholder string. */
  url?: string;
  status: string;
  timestamp: string;
  name: string;
  appName: string;
  runtime?: string;
  execution_class?: PublicDeployment["execution_class"];
  access?: PublicDeployment["access"];
  billing?: Record<string, unknown> | null;
  /** The latest durable run and its sealed outcome, as served (D9). */
  run_id: string | null;
  outcome: unknown;
  /** That run's `public_status`; single-deployment reads only, `null` = unobserved. */
  run_status?: string | null;
  http_probe?: HttpProbe;
}

export interface HttpProbe {
  outcome: "reachable" | "http_error" | "network_error" | "not_applicable";
  http_status?: number;
  latency_ms?: number;
}

export async function checkLiveness(
  url: string | undefined
): Promise<HttpProbe> {
  if (!url || !url.startsWith("http")) {
    return { outcome: "not_applicable" };
  }
  try {
    const start = Date.now();
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    return {
      outcome: res.ok ? "reachable" : "http_error",
      http_status: res.status,
      latency_ms: Date.now() - start,
    };
  } catch {
    return { outcome: "network_error" };
  }
}

export async function applyLiveness(deployments: DeploymentRecord[]): Promise<void> {
  const results = await Promise.all(deployments.map((d) => checkLiveness(d.url)));
  for (let i = 0; i < deployments.length; i++) {
    deployments[i]!.http_probe = results[i]!;
  }
}

/** Served row fields `PublicDeployment` does not type (gateway `PUBLIC_DEPLOYMENT_KEYS`). */
type ServedDeployment = PublicDeployment & { run_id?: string | null; outcome?: unknown };

/** Said wherever a URL would be, while the owner has not assigned one. */
export const URL_PENDING = "URL not assigned yet";

/**
 * The served `billing` block with no false zero: `accrued_this_month_usd` is
 * trusted only while `billing.state` is observed. With `state: null` the owner
 * has not measured the interval (an hourly machine, a fresh or legacy row) and
 * serves a placeholder 0, so the MCP says `"unavailable"` instead
 * (journey D F1: a CPU VM read $0 while the portal showed $0.52).
 */
export function truthfulBilling(billing: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!billing) return null;
  if (billing.state != null || !("accrued_this_month_usd" in billing)) return billing;
  return { ...billing, accrued_this_month_usd: "unavailable" };
}

export function normalizeDeployment(item: ServedDeployment): DeploymentRecord {
  const name = item.subdomain ?? item.app_name ?? item.appName ?? item.id;
  const url = item.url ?? item.public_url;
  return {
    // `varity_deploy` returns the operation id; the row id switches from it to
    // a registry id at go-live (journey D F6). Both resolve as input.
    id: item.operation_deployment_id ?? item.id ?? name,
    name,
    appName: item.appName ?? item.app_name ?? name,
    ...(item.runtime ? { runtime: item.runtime } : {}),
    ...(item.execution_class !== undefined ? { execution_class: item.execution_class } : {}),
    ...(item.access !== undefined ? { access: item.access } : {}),
    ...(url ? { url } : {}),
    status: item.status ?? "unknown",
    timestamp: item.createdAt ?? item.created_at ?? "unknown",
    billing: truthfulBilling(item.billing),
    run_id: item.run_id ?? null,
    outcome: item.outcome ?? null,
  };
}

/** Read the run's `public_status` so a failed deploy shows why, not only `failed`. */
async function readRunStatus(runId: string | null): Promise<string | null> {
  if (!runId) return null;
  try {
    const run = await getRun(runId);
    return typeof run.public_status === "string" ? run.public_status : null;
  } catch {
    return null;
  }
}

async function readDeployments(): Promise<DeploymentRecord[]> {
  const deployments = (await listDeployments()).map(normalizeDeployment);
  return deployments.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

function apiFailure(err: unknown, action: string) {
  if (err instanceof VarityPublicApiError) {
    return errorResponse(err.code, err.message, err.action ?? action);
  }
  return errorResponse("VARITY_API_ERROR", "Varity API request failed.", action);
}

export function registerDeployStatusTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy_status",
    {
      title: "Deployment Status",
      description:
        "List deployments or get status of a specific deployment. " +
        "Shows the owner-scoped fields returned by the Varity public interface, including URL, SSH access, execution class, status, runtime when available, and creation time. " +
        "A separate HTTP probe records reachability without overwriting the owner's lifecycle status; authenticated, POST-only, or transiently unavailable apps may return a non-2xx probe. " +
        "Use this when a developer asks about their deployments, wants to check status, " +
        "or needs to find a deployment URL.",
      inputSchema: {
        deployment_id: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment ID format")
          .optional()
          .describe(
            "Specific deployment ID to check (optional, omit to list recent)"
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Compatibility hint from older clients. Deployment state is now account-scoped through the Varity public API."
          ),
        limit: z
          .coerce.number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe(
            "Maximum number of deployments to return (default: 10, max: 50)"
          ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ deployment_id, path, limit }) => {
      try {
        if (deployment_id) {
          const deployment = normalizeDeployment(await getDeployment(deployment_id));
          deployment.run_status = await readRunStatus(deployment.run_id);
          await applyLiveness([deployment]);

          return successResponse(
            { deployment, source: "varity_public_api:/api/deployments" },
            `Deployment ${deployment.id}: ${deployment.status}${deployment.url ? ` at ${deployment.url}` : ` (${deployment.access?.protocol === "ssh" ? "SSH access available" : URL_PENDING})`}`
          );
        }

        const deployments = await readDeployments();

        if (deployments.length === 0) {
          return successResponse(
            { deployments: [], total: 0, source: "varity_public_api:/api/deployments" },
            "No deployments found. Deploy your first app with the varity_deploy tool."
          );
        }

        const maxResults = limit ?? 10;
        const limited = deployments.slice(0, maxResults);
        const hasMore = deployments.length > maxResults;

        await applyLiveness(limited);

        return successResponse(
          {
            deployments: limited,
            total: deployments.length,
            showing: limited.length,
            source: "varity_public_api:/api/deployments",
            scope: "account-wide",
            ...(path ? { compatibility_note: "The path filter is ignored because the public API is owner-scoped, not machine-local." } : {}),
            ...(hasMore
              ? { pagination_note: `Showing ${limited.length} of ${deployments.length}. Increase "limit" to see more.` }
              : {}),
          },
          `Found ${deployments.length} deployment(s). Most recent: ${limited[0]!.name} (${limited[0]!.url ?? URL_PENDING})`
        );
      } catch (err) {
        return apiFailure(err, "Run varity_login, then retry varity_deploy_status.");
      }
    }
  );
}
