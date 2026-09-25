import { z } from "zod";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { createDeployment, VarityPublicApiError } from "../utils/public-api.js";
import { lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";

/**
 * `varity_deploy` → `POST /api/deployments` through the one public-API client
 * (no `varitykit` subprocess). The body is the same public create contract
 * the CLI sends (`app_name`, `repo_url` | `image`, `port`, `volume_*`); the
 * control plane owns framework detection, hosting, build and lifecycle. The
 * MCP only names the source: an explicit repo/image, else the project's
 * `origin` remote. A bare local directory has nothing the cloud can build.
 */

/** The `origin` remote of `<project>/.git/config`, as an https URL the backend can clone. */
export async function detectGitRemote(projectPath: string): Promise<string | null> {
  let config: string;
  try {
    config = await readFile(join(projectPath, ".git", "config"), "utf-8");
  } catch {
    return null;
  }
  let inOrigin = false;
  let url: string | null = null;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = line === '[remote "origin"]';
    } else if (inOrigin && line.startsWith("url") && line.includes("=")) {
      url = line.slice(line.indexOf("=") + 1).trim();
      break;
    }
  }
  if (!url) return null;
  if (url.startsWith("git@")) {
    // git@github.com:owner/repo.git -> https://github.com/owner/repo
    const [host, path] = [url.slice(4, url.indexOf(":")), url.slice(url.indexOf(":") + 1)];
    url = `https://${host}/${path}`;
  }
  return url.replace(/\.git$/, "");
}

/** A contract-valid app name (`^[a-z0-9-]{1,63}$`) from the repo or image name. */
export function defaultAppName(source: string): string {
  const last = source.split("@")[0]!.replace(/\/+$/, "").split("/").pop()!.split(":")[0]!.replace(/\.git$/, "");
  return (last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app").slice(0, 63);
}

export async function deployAccepted(accepted: Awaited<ReturnType<typeof createDeployment>>) {
  const acceptance = await lifecycleAcceptance(accepted);
  return successResponse(
    {
      accepted: true,
      id: accepted.id ?? null,
      app_name: accepted.app_name ?? null,
      ...acceptance,
    },
    acceptance.run_id
      ? `Deploy accepted (run ${acceptance.run_id}, status ${acceptance.public_status ?? "unobserved"}). Track its terminal outcome with varity_deploy_status.`
      : "The deploy request returned no run. A live deployment is not yet proven; inspect varity_deploy_status before reporting completion."
  );
}

export function registerDeployTool(server: McpServer): void {
  server.registerTool(
    "varity_deploy",
    {
      title: "Deploy to Production",
      description:
        "Submit a Git repository or a prebuilt container image to Varity's deployment owner. " +
        "The control plane detects the framework, selects hosting, builds, and manages lifecycle state. " +
        "Use this when a developer wants to deploy, publish, ship, or make their app live. " +
        "If the developer wants to deploy a certified template rather than their own code, " +
        "use varity_deploy_template instead. To stop a deployment and its billing, use varity_delete_deployment.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the project directory (e.g. '/home/user/my-app'). " +
            "Used only to read the Git `origin` remote when repo_url and image are omitted. " +
            "If omitted, the MCP server's working directory is used (which is rarely the correct project root)."
          ),
        repo_url: z
          .string()
          .optional()
          .describe(
            "GitHub repository URL for the app (e.g. 'https://github.com/user/my-app'). " +
            "If omitted, auto-detected from .git/config. " +
            "Use the repo_url returned by varity_create_repo as the value here."
          ),
        app_name: z
          .string()
          .optional()
          .describe(
            "Custom app name that controls the deployment URL: https://varity.app/{app_name}/. " +
            "Must be URL-safe (lowercase letters, numbers, hyphens). " +
            "If omitted, the repository or image name is used. " +
            "Use a different app_name to create named environments (staging, canary, etc.)."
          ),
        image: z
          .string()
          .optional()
          .describe(
            "Deploy a prebuilt Docker/OCI image directly (e.g. 'ghcr.io/you/app:latest') instead of " +
            "building from source. Use when the developer has a container image rather than a repo/project. " +
            "Mutually exclusive with repo_url."
          ),
        port: z
          .number()
          .int()
          .optional()
          .describe("Container listen port for an image deploy (default 80)."),
        volume_size: z
          .number()
          .int()
          .optional()
          .describe(
            "Persistent volume size in GB for the app container (survives restart/redeploy). " +
            "Use for stateful apps (databases, n8n, Ghost, etc.). Requires volume_path."
          ),
        volume_path: z
          .string()
          .optional()
          .describe(
            "Absolute container path to mount the persistent volume (e.g. '/data', '/home/node/.n8n'). " +
            "Requires volume_size."
          ),
      },
      annotations: {
        destructiveHint: true, // Deploys real infrastructure
      },
    },
    async ({ path, repo_url, app_name, image, port, volume_size, volume_path }) => {
      if (repo_url && image) {
        return errorResponse("INVALID_SOURCE", "Pass repo_url or image, not both.", "Choose one deploy source.");
      }
      let repoUrl = repo_url;
      if (!repoUrl && !image) {
        const cwd = path || process.cwd();
        try {
          await access(cwd);
        } catch {
          return errorResponse(
            "PATH_NOT_FOUND",
            `Project directory does not exist: ${cwd}`,
            "Check the path and ensure the project directory exists."
          );
        }
        repoUrl = (await detectGitRemote(cwd)) ?? undefined;
        if (!repoUrl) {
          return errorResponse(
            "NO_DEPLOY_SOURCE",
            `No deploy source found for ${cwd}: it has no Git origin remote.`,
            "Varity builds in the cloud from a source it can reach. Push the project with varity_create_repo and pass its repo_url, or pass a prebuilt image."
          );
        }
      }

      const source = (image ?? repoUrl)!;
      const request: Record<string, unknown> = { app_name: app_name || defaultAppName(source) };
      if (image) {
        request.image = image;
        request.hosting = "dynamic"; // a prebuilt container image is always a dynamic deploy
        if (port) request.port = port;
      } else {
        request.repo_url = repoUrl;
      }
      if (volume_size != null) request.volume_size_gb = volume_size;
      if (volume_path) request.volume_path = volume_path;

      try {
        return await deployAccepted(await createDeployment(request));
      } catch (err) {
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? "Check the request and retry.");
        }
        return errorResponse("DEPLOY_FAILED", "The deploy request failed.", "Retry the request.");
      }
    }
  );
}
