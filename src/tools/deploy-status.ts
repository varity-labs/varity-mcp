import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  getDeployment,
  listDeployments,
  VarityPublicApiError,
  type PublicDeployment,
} from "../utils/public-api.js";

interface DeploymentRecord {
  id: string;
  url: string;
  status: string;
  timestamp: string;
  name: string;
  appName: string;
  runtime: string;
  billing?: Record<string, unknown> | null;
  http_status?: number;
  latency_ms?: number;
}

export async function checkLiveness(
  url: string
): Promise<{ live: boolean; httpStatus?: number; latencyMs?: number }> {
  if (!url || url === "unknown" || !url.startsWith("http")) {
    return { live: false };
  }
  try {
    const start = Date.now();
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    return { live: res.ok, httpStatus: res.status, latencyMs: Date.now() - start };
  } catch {
    return { live: false };
  }
}

async function applyLiveness(deployments: DeploymentRecord[]): Promise<void> {
  const results = await Promise.all(deployments.map((d) => checkLiveness(d.url)));
  for (let i = 0; i < deployments.length; i++) {
    const { live, httpStatus, latencyMs } = results[i]!;
    if ((deployments[i]!.status === "deployed" || deployments[i]!.status === "live") && !live) {
      deployments[i]!.status = "unhealthy";
    }
    if (httpStatus !== undefined) deployments[i]!.http_status = httpStatus;
    if (latencyMs !== undefined) deployments[i]!.latency_ms = latencyMs;
  }
}

function normalizeDeployment(item: PublicDeployment): DeploymentRecord {
  const name = item.subdomain ?? item.app_name ?? item.appName ?? item.id;
  return {
    id: item.id ?? name,
    name,
    appName: item.appName ?? item.app_name ?? name,
    runtime: item.runtime ?? "unknown",
    url: item.url ?? item.public_url ?? "unknown",
    status: item.status ?? "unknown",
    timestamp: item.createdAt ?? item.created_at ?? "unknown",
    billing: item.billing ?? null,
  };
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
        "Shows URL, status, framework, size, and creation time. " +
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
          await applyLiveness([deployment]);

          return successResponse(
            { deployment, source: "varity_public_api:/api/deployments" },
            `Deployment ${deployment.id}: ${deployment.status} at ${deployment.url}`
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
          `Found ${deployments.length} deployment(s). Most recent: ${limited[0]!.url}`
        );
      } catch (err) {
        return apiFailure(err, "Run varity_login, then retry varity_deploy_status.");
      }
    }
  );
}
