import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { getDeploymentsDir } from "../utils/config.js";

interface DeploymentRecord {
  id: string;
  url: string;
  framework: string;
  status: string;
  size: string;
  timestamp: string;
  path: string;
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
    if (deployments[i]!.status === "deployed" && !live) {
      deployments[i]!.status = "unhealthy";
    }
    if (httpStatus !== undefined) deployments[i]!.http_status = httpStatus;
    if (latencyMs !== undefined) deployments[i]!.latency_ms = latencyMs;
  }
}

async function readDeployments(): Promise<DeploymentRecord[]> {
  const deploymentsDir = getDeploymentsDir();
  const deployments: DeploymentRecord[] = [];

  try {
    const files = await readdir(deploymentsDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(deploymentsDir, file), "utf-8");
        const data = JSON.parse(content);
        // Resolve the live URL — always prefer clean varity.app custom domain over raw provider URLs
        const rawUrl =
          data.custom_domain?.url ||   // clean varity.app URL registered at deploy time
          data.url ||
          data.deployment_url ||
          data.akash?.url ||
          data.ipfs?.gateway_url ||
          "unknown";
        // Convert raw storage URLs to clean varity.app/{app-name}/ — use app name slug, never the deployment ID
        const appSlug =
          data.custom_domain?.subdomain ||   // most reliable: registered subdomain
          data.app_name ||
          data.project_name ||
          data.project?.name ||
          (data.path ? data.path.split("/").pop() : null);  // last dir segment as fallback
        // Always construct a clean varity.app URL — never expose raw provider URLs
        const cleanUrl = appSlug
          ? `https://varity.app/${appSlug}/`
          : (rawUrl.includes("ipfs.io/ipfs/") ? `https://varity.app/${file.replace(".json", "")}/` : rawUrl);

        deployments.push({
          id: file.replace(".json", ""),
          url: cleanUrl,
          framework:
            data.framework ||
            data.project?.type ||
            "unknown",
          status: data.status || (data.build?.success ? "deployed" : "failed"),
          size:
            data.size ||
            data.build_size ||
            (data.build?.size_mb ? `${data.build.size_mb.toFixed(1)} MB` : "unknown"),
          timestamp: data.timestamp || data.deployed_at || "unknown",
          // Show the app name so developers can identify which project this belongs to.
          // Never expose full filesystem paths — use app_name only.
          path: appSlug || file.replace(".json", ""),
        });
      } catch {
        // Skip malformed deployment files
      }
    }
  } catch {
    // Deployments directory doesn't exist yet
  }

  // Sort by timestamp, newest first
  return deployments.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * Filter deployments to only those matching the given project path.
 * Matches if the deployment path starts with or is contained within the project path.
 */
function filterByProject(
  deployments: DeploymentRecord[],
  projectPath: string
): DeploymentRecord[] {
  const normalized = resolve(projectPath);
  return deployments.filter((d) => {
    if (d.path === "unknown") return false;
    // Match deployments whose source path is under the project directory
    // e.g. project "/home/user/my-app" matches deploy path "/home/user/my-app/out"
    return resolve(d.path).startsWith(normalized);
  });
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
            "Specific deployment ID to check (optional — omit to list recent)"
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Project directory path — only show deployments for this project"
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
      let deployments = await readDeployments();

      // Single deployment lookup
      if (deployment_id) {
        const deployment = deployments.find((d) => d.id === deployment_id);
        if (!deployment) {
          return errorResponse(
            "DEPLOYMENT_NOT_FOUND",
            `Deployment "${deployment_id}" not found.`,
            `Use varity_deploy_status without a deployment_id to list recent deployments.`
          );
        }

        await applyLiveness([deployment]);

        return successResponse(
          { deployment },
          `Deployment ${deployment.id}: ${deployment.status} at ${deployment.url}`
        );
      }

      // Filter by project path if provided
      if (path) {
        deployments = filterByProject(deployments, path);
      }

      if (deployments.length === 0) {
        const msg = path
          ? `No deployments found for project at ${path}. Deploy with the varity_deploy tool.`
          : "No deployments found. Deploy your first app with the varity_deploy tool.";
        return successResponse({ deployments: [], total: 0 }, msg);
      }

      // Apply limit
      const maxResults = limit ?? 10;
      const limited = deployments.slice(0, maxResults);
      const hasMore = deployments.length > maxResults;

      await applyLiveness(limited);

      return successResponse(
        {
          deployments: limited,
          total: deployments.length,
          showing: limited.length,
          // When no path filter was applied, make it explicit these are account-wide results
          // so developers don't mistake another project's deployments for their own.
          ...(!path ? { scope: "account-wide", scope_note: `Showing deployments across all projects on this machine. Pass the \`path\` parameter (e.g., your project directory) to filter to a specific project.` } : { scope: "project-filtered" }),
          ...(hasMore
            ? { pagination_note: `Showing ${limited.length} of ${deployments.length}. Increase "limit" to see more.` }
            : {}),
        },
        `Found ${deployments.length} deployment(s). Most recent: ${limited[0]!.url}`
      );
    }
  );
}
