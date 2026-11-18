import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import { createDeployment, VarityPublicApiError } from "../utils/public-api.js";
import { acceptanceSummary, lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";

/**
 * `varity_deploy` → `POST /api/deployments` through the one public-API client
 * (no CLI subprocess). The body is the same public create contract
 * the CLI sends (`app_name`, `repo_url` | `image`, `port`, `volume_*`); the
 * control plane owns framework detection, hosting, build and lifecycle. The
 * MCP only names the source: an explicit repo/image, else (stdio only) the
 * project's `origin` remote through the injected `LocalSource`. A bare local
 * directory has nothing the cloud can build. The remote toolset registers
 * this tool without a local source, so its schema has no `path` and this
 * module reads no file.
 */

/** Resolves a project directory to its deploy source; stdio only (`deploy-local-source.ts`). */
export type LocalSource = (path: string | undefined) => Promise<{ repoUrl: string } | ReturnType<typeof errorResponse>>;

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
    acceptanceSummary("Deploy", accepted.id, acceptance)
  );
}

/**
 * The gateway answers 422 `source_repository_unreadable` for a private or
 * missing repository. The local MCP sends no git credential, so its served
 * advice about "the supplied token" does not apply (E1 journey 1).
 */
function unreadableRepository(repoUrl: string | undefined): [string, string] {
  const slug = repoUrl?.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? "<owner>/<repo>";
  return [
    "Varity could not read this repository: it is private or does not exist. " +
      "Varity can only build from public repositories today, so nothing was deployed and nothing was charged.",
    "Explain this plainly and offer the paths that keep the code private: deploy a ready-made Varity template " +
      "(varity_list_templates), or deploy a prebuilt container image with the image argument. " +
      `Only if the user decides to publish the code can the repository be made public (gh repo edit ${slug} --visibility public --accept-visibility-change-consequences); ask first.`,
  ];
}

export function registerDeployTool(server: McpServer, localSource?: LocalSource): void {
  const pathInput = {
    path: z
      .string()
      .optional()
      .describe(
        "Absolute path to the project directory (e.g. '/home/user/my-app'). " +
        "Used only to read the Git `origin` remote when repo_url and image are omitted. " +
        "If omitted, the MCP server's working directory is used (which is rarely the correct project root)."
      ),
  };
  const repoUrlHint = localSource
    ? "If omitted, auto-detected from .git/config. Use the repo_url returned by varity_create_repo as the value here."
    : "Pass repo_url or image.";
  server.registerTool(
    "varity_deploy",
    {
      title: "Deploy to Production",
      description:
        "Submit a Git repository or a prebuilt container image to Varity's deployment owner. " +
        "The control plane detects the framework, selects hosting, builds, and manages lifecycle state. " +
        "Use this when a developer wants to deploy, publish, ship, or make their app live. " +
        "If the developer wants to deploy a certified template rather than their own code, " +
        "use varity_deploy_template instead. To ship new code for an app that is already deployed, push it and call " +
        "varity_deploy again with the same app_name: the same owner and workload shape updates that app in place at " +
        "the latest commit (varity_redeploy does not pick up new commits). " +
        "To stop a deployment and its billing, use varity_delete_deployment.",
      inputSchema: {
        ...(localSource ? pathInput : {}),
        repo_url: z
          .string()
          .optional()
          .describe(
            "GitHub repository URL for the app (e.g. 'https://github.com/user/my-app'). " + repoUrlHint
          ),
        app_name: z
          .string()
          .optional()
          .describe(
            "Custom app name that controls the deployment URL. A static site is served at " +
            "https://varity.app/{app_name}/ and an app with a server at https://{app_name}.varity.app; " +
            "the platform picks which, so read the live URL from varity_deploy_status. " +
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path, repo_url, app_name, image, port, volume_size, volume_path }: {
      path?: string; repo_url?: string; app_name?: string; image?: string; port?: number; volume_size?: number; volume_path?: string;
    }) => {
      if (repo_url && image) {
        return errorResponse("INVALID_SOURCE", "Pass repo_url or image, not both.", "Choose one deploy source.");
      }
      let repoUrl = repo_url;
      if (!repoUrl && !image) {
        if (!localSource) {
          return errorResponse(
            "NO_DEPLOY_SOURCE",
            "No deploy source: pass repo_url or image.",
            "Pass the app's public GitHub repo_url or a prebuilt image, or deploy a certified template with varity_deploy_template."
          );
        }
        const local = await localSource(path);
        if (!("repoUrl" in local)) return local;
        repoUrl = local.repoUrl;
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
        if (err instanceof VarityPublicApiError && err.code === "source_repository_unreadable") {
          return errorResponse(err.code, ...unreadableRepository(repoUrl));
        }
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? "Check the request and retry.");
        }
        return errorResponse("DEPLOY_FAILED", "The deploy request failed.", "Retry the request.");
      }
    }
  );
}
