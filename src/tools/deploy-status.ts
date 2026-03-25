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
        deployments.push({
          id: file.replace(".json", ""),
          url:
            data.url ||
            data.deployment_url ||
            data.ipfs?.gateway_url ||
            data.ipfs?.thirdweb_url ||
            data.akash?.url ||
            "unknown",
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
          path: data.path || data.project_path || data.build?.output_dir || "unknown",
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

      return successResponse(
        {
          deployments: limited,
          total: deployments.length,
          showing: limited.length,
          ...(hasMore
            ? { note: `Showing ${limited.length} of ${deployments.length}. Increase "limit" to see more.` }
            : {}),
        },
        `Found ${deployments.length} deployment(s). Most recent: ${limited[0]!.url}`
      );
    }
  );
}
