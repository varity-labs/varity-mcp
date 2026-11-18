import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  createDeployment,
  createUploadDeployment,
  createUploadSource,
  uploadSourceArchive,
  VarityPublicApiError,
} from "../utils/public-api.js";
import { acceptanceSummary, lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";
import type { CollectedFolder, PackedFolder } from "./pack.js";
import { deployPrivateCopy, type FolderDeploy } from "./deploy-private-copy.js";
import {
  ARCHIVE_REFUSALS,
  deployDescription,
  NEEDS_PATH,
  NO_FOLDER_YET,
  NO_GITHUB_PATH,
  PATH_DESCRIPTION,
  repoUrlHint,
  sayExactly,
  SOURCE_DESCRIPTION,
  UPLOAD_UNAVAILABLE_ACTION,
} from "./deploy-copy.js";

/**
 * `varity_deploy` → `POST /api/deployments` through the one public-API client
 * (no CLI subprocess). The body is the same public create contract
 * the CLI sends (`app_name`, `repo_url` | `image`, `port`, `volume_*`); the
 * control plane owns framework detection, hosting, build and lifecycle. The
 * MCP only names the source: an explicit repo/image, else (stdio only) the
 * project's `origin` remote through the injected `LocalSource`. A folder with
 * no public GitHub repo (no `origin`, or one Varity cannot read) is collected
 * and uploaded through IF-UPLOAD (`POST /api/deployments/sources`, then a PUT
 * of the archive, then a create naming the sealed `source_id`); while that
 * route is unavailable it is saved as a private copy Varity keeps and
 * deployed from its commit (`deploy-private-copy.ts`). The remote toolset registers this
 * tool without a local source, so its schema has no `path` and this module
 * reads no file.
 */

/** A project folder, its `origin` remote, its walk and its packer; stdio only (`deploy-local-source.ts`). */
export interface LocalSource {
  resolve(
    path: string | undefined
  ): Promise<{ folder: string; repoUrl: string | null; explicit: boolean } | ReturnType<typeof errorResponse>>;
  /** Throws `PackRefused` with plain copy when the folder cannot be read or sent. */
  collect(folder: string): Promise<CollectedFolder>;
  /** The upload archive of a collected folder; throws `PackRefused` when it cannot be uploaded. */
  pack(collected: CollectedFolder): Promise<PackedFolder>;
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
    `Building now; usually live in under a minute. ${acceptanceSummary("Deploy", accepted.id, acceptance)}`
  );
}

/**
 * What this server has seen the upload route answer (J-23/E3): "available"
 * once an archive upload succeeded, "unavailable" once the route answered off
 * (404/405/501/`uploads_unavailable`). There is no side-effect-free probe, so
 * until an upload works no copy promises one. One per registered tool.
 */
interface UploadState {
  upload: "unknown" | "available" | "unavailable";
}

/**
 * The gateway answers 422 `source_repository_unreadable` for a private or
 * missing repository. The local MCP sends no git credential, so its served
 * advice about "the supplied token" does not apply (E1 journey 1). With a
 * local folder the upload leads only once this process has seen it work (U-6);
 * otherwise the no-GitHub path leads, then templates and images.
 */
function unreadableRepository(repoUrl: string | undefined, canUpload: boolean, state: UploadState): [string, string] {
  const slug = repoUrl?.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? "<owner>/<repo>";
  const publish =
    `Only if the user decides to publish the code can the repository be made public (gh repo edit ${slug} --visibility public --accept-visibility-change-consequences); ask first.`;
  if (canUpload && state.upload === "available") {
    return [
      "Varity could not read this repository: it is private or does not exist. Nothing was deployed and nothing was charged.",
      "Offer this first, in plain words: \"I'll upload your project folder to Varity instead; your code stays private.\" " +
        "Then call varity_deploy again with path set to the project folder and source \"upload\" (no repo_url). " +
        "Other private paths: a ready-made Varity template (varity_list_templates) or a prebuilt container image (image argument). " +
        publish,
    ];
  }
  const tryUpload =
    canUpload && state.upload === "unknown"
      ? "If the user wants their own folder online, you may try varity_deploy with path set to the project folder and source \"upload\", " +
        "but do not promise it works or that the code stays private: if it answers UPLOAD_UNAVAILABLE, Varity can't take a folder from this computer yet. "
      : "";
  return [
    sayExactly("Varity can't read this project's code on GitHub: it is private or does not exist. Nothing was deployed or charged."),
    `Explain this plainly${canUpload && state.upload === "unavailable" ? ` (${NO_FOLDER_YET})` : ""}. ${NO_GITHUB_PATH} ` +
      tryUpload +
      "For developers, paths that keep the code private: a ready-made Varity template (varity_list_templates) " +
      "or a prebuilt container image (image argument). " +
      publish,
  ];
}

/** The gateway route (U-5) or the deploy-api flag is off: nothing was uploaded. */
function uploadUnavailable(err: VarityPublicApiError): boolean {
  if (err.code === "source_not_found") return false;
  return err.status === 404 || err.status === 405 || err.status === 501 || err.code === "uploads_unavailable";
}

/** No route takes a folder from this computer: the no-GitHub copy (Chat and Build first). */
function folderUnavailable(step: "upload" | "deploy") {
  return errorResponse(
    "UPLOAD_UNAVAILABLE",
    sayExactly(`${NO_FOLDER_YET} ${step === "upload" ? "Nothing was uploaded, deployed or charged." : "Nothing was deployed or charged."}`),
    UPLOAD_UNAVAILABLE_ACTION
  );
}

function uploadError(err: unknown, step: "upload" | "deploy", state: UploadState) {
  if (!(err instanceof VarityPublicApiError)) {
    return errorResponse("UPLOAD_FAILED", "The folder upload failed, so nothing was deployed or charged.", "Retry the deploy.");
  }
  if ((step === "upload" && uploadUnavailable(err)) || err.code === "uploads_unavailable") {
    state.upload = "unavailable";
    return folderUnavailable(step);
  }
  if (err.code === "source_too_large") {
    return errorResponse(
      err.code,
      "Varity refused the upload: the packed folder is over the upload size limit. Nothing was deployed or charged.",
      "Add large generated, media or data folders to .gitignore, then deploy again."
    );
  }
  if (err.code === "source_archive_refused") {
    const field = typeof err.served?.field === "string" ? err.served.field : "";
    const why = Object.hasOwn(ARCHIVE_REFUSALS, field) ? ARCHIVE_REFUSALS[field] : "it did not pass Varity's checks";
    return errorResponse(
      err.code,
      `Varity refused the upload because ${why}. Nothing was deployed or charged. ${err.message}`.trim(),
      field === "secret_path"
        ? "Move that file out of the project folder or add it to .gitignore (give the app its settings with varity_set_env), then deploy again."
        : "Fix the named file or add it to .gitignore, then deploy again."
    );
  }
  if (err.status === 408 || err.status === 429 || err.status === 503) {
    return errorResponse(err.code, `${err.message} Nothing was deployed or charged.`, "Wait a minute, then deploy again.");
  }
  return errorResponse(
    err.code,
    step === "deploy" ? `The folder was uploaded, but the deploy was not started: ${err.message}` : err.message,
    err.action ?? "Check the request and retry."
  );
}

function packRefusal(err: unknown, folder: string) {
  const refused = err as { code?: string; message?: string; action?: string };
  if (refused?.code && refused.action) return errorResponse(refused.code, refused.message ?? "", refused.action);
  return errorResponse("PACK_FAILED", `Could not read the project folder ${folder}, so nothing was uploaded.`, "Check the path and file permissions.");
}

/** The upload's answer: a final result, or the route answered off (its no-folder answer kept). */
type UploadOutcome =
  | { kind: "done"; result: ReturnType<typeof errorResponse> | ReturnType<typeof successResponse> }
  | { kind: "off"; answer: ReturnType<typeof errorResponse> };

/**
 * PLAN-R1 M3 order, three branches:
 * 1. this server has not seen the upload route off: pack and upload (U-6); a
 *    folder the upload cannot take gets the upload's own refusal; only a
 *    route that answers off moves on to the private copy;
 * 2. the upload route is off: save a private copy (its own caps);
 * 3. that route is off too: the upload's no-folder answer.
 */
async function deployFolder(local: LocalSource, folder: string, deploy: FolderDeploy, state: UploadState) {
  let collected: CollectedFolder;
  try {
    collected = await local.collect(folder);
  } catch (err) {
    return packRefusal(err, folder);
  }
  let offAnswer: ReturnType<typeof errorResponse> | undefined;
  if (state.upload !== "unavailable") {
    let packed: PackedFolder;
    try {
      packed = await local.pack(collected);
    } catch (err) {
      return packRefusal(err, folder);
    }
    const upload = await uploadFolder(packed, deploy, state);
    if (upload.kind === "done") return upload.result;
    offAnswer = upload.answer;
  }
  return (await deployPrivateCopy(collected, deploy)) ?? offAnswer ?? folderUnavailable("upload");
}

async function uploadFolder(packed: PackedFolder, deploy: FolderDeploy, state: UploadState): Promise<UploadOutcome> {
  // `uploadError` marks the route off; that answer is the "off" outcome.
  const failed = (err: unknown, step: "upload" | "deploy"): UploadOutcome => {
    const answer = uploadError(err, step, state);
    return state.upload === "unavailable" ? { kind: "off", answer } : { kind: "done", result: answer };
  };
  let sourceId: string;
  try {
    const slot = await createUploadSource();
    if (packed.archive.length > slot.max_bytes) {
      return {
        kind: "done",
        result: errorResponse(
          "source_too_large",
          `The packed folder is ${(packed.archive.length / 1024 / 1024).toFixed(1)} MB, over this account's ${Math.floor(slot.max_bytes / 1024 / 1024)} MB upload limit. Nothing was uploaded, deployed or charged.`,
          "Add large generated, media or data folders to .gitignore, then deploy again."
        ),
      };
    }
    await uploadSourceArchive(slot, packed.archive);
    state.upload = "available";
    sourceId = slot.source_id;
  } catch (err) {
    return failed(err, "upload");
  }
  let accepted: Awaited<ReturnType<typeof createUploadDeployment>>;
  try {
    accepted = await createUploadDeployment({ app_name: deploy.appName, ...deploy.volume }, sourceId);
  } catch (err) {
    return failed(err, "deploy");
  }
  const acceptance = await lifecycleAcceptance(accepted);
  const secrets = packed.secretPaths;
  const notes = [
    `${deploy.why ? `${deploy.why} ` : ""}I uploaded this folder to Varity (${packed.fileCount} files); your code stays private and nothing was published to GitHub.`,
    packed.excludedCount > 0
      ? `Left out ${packed.excludedCount} ignored items (dependencies, build output and anything in .gitignore).`
      : "",
    secrets.length > 0
      ? `Kept these secret files on this computer and did not upload them: ${secrets.join(", ")}. Give the app its settings with varity_set_env.`
      : "",
  ].filter(Boolean);
  const result = successResponse(
    {
      accepted: true,
      id: accepted.id ?? null,
      app_name: accepted.app_name ?? null,
      source: "upload",
      uploaded_files: packed.fileCount,
      left_out_count: packed.excludedCount,
      secret_files_not_uploaded: secrets,
      ...acceptance,
    },
    `${notes.join(" ")} Building now; usually live in under a minute. ${acceptanceSummary("Deploy", accepted.id, acceptance)}`
  );
  return { kind: "done", result };
}

/** The last segment of a local folder path, on any platform. */
function folderName(folder: string): string {
  return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "app";
}

export function registerDeployTool(server: McpServer, localSource?: LocalSource): void {
  const uploadState: UploadState = { upload: "unknown" };
  const pathInput = {
    path: z.string().optional().describe(PATH_DESCRIPTION),
    source: z.enum(["upload"]).optional().describe(SOURCE_DESCRIPTION),
  };
  server.registerTool(
    "varity_deploy",
    {
      title: "Deploy to Production",
      description: deployDescription(Boolean(localSource)),
      inputSchema: {
        ...(localSource ? pathInput : {}),
        repo_url: z
          .string()
          .optional()
          .describe(
            "GitHub repository URL for the app (e.g. 'https://github.com/user/my-app'). " + repoUrlHint(Boolean(localSource))
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
    async ({ path, source, repo_url, app_name, image, port, volume_size, volume_path }: {
      path?: string; source?: "upload"; repo_url?: string; app_name?: string; image?: string; port?: number; volume_size?: number; volume_path?: string;
    }) => {
      const startedAt = Date.now();
      if ([repo_url, image, source].filter(Boolean).length > 1) {
        return errorResponse("INVALID_SOURCE", "Pass one of repo_url, image or source \"upload\", not several.", "Choose one deploy source.");
      }
      const volume: Record<string, unknown> = {};
      if (volume_size != null) volume.volume_size_gb = volume_size;
      if (volume_path) volume.volume_path = volume_path;
      let repoUrl = repo_url;
      let folder: { folder: string; explicit: boolean } | undefined;
      if (!repoUrl && !image) {
        if (!localSource) {
          return errorResponse(
            "NO_DEPLOY_SOURCE",
            "No deploy source: pass repo_url or image.",
            "Pass the app's public GitHub repo_url or a prebuilt image, or deploy a certified template with varity_deploy_template."
          );
        }
        const local = await localSource.resolve(path);
        if (!("folder" in local)) return local;
        folder = local;
        const upload = (why: string) =>
          local.explicit
            ? deployFolder(localSource, local.folder, { appName: app_name || defaultAppName(folderName(local.folder)), volume, why, startedAt }, uploadState)
            : Promise.resolve(errorResponse("PROJECT_PATH_REQUIRED", `${why ? `${why} to upload it I need` : "Uploading needs"} the folder's exact location.`, NEEDS_PATH));
        if (source === "upload") return upload("");
        if (!local.repoUrl) return upload("This project has no GitHub repository, so");
        repoUrl = local.repoUrl;
      }

      const named = (image ?? repoUrl)!;
      const request: Record<string, unknown> = { app_name: app_name || defaultAppName(named) };
      if (image) {
        request.image = image;
        request.hosting = "dynamic"; // a prebuilt container image is always a dynamic deploy
        if (port) request.port = port;
      } else {
        request.repo_url = repoUrl;
      }
      Object.assign(request, volume);

      try {
        return await deployAccepted(await createDeployment(request));
      } catch (err) {
        if (err instanceof VarityPublicApiError && err.code === "source_repository_unreadable") {
          // The repo came from this folder's origin: deploy the folder itself, privately.
          if (localSource && folder?.explicit) {
            return deployFolder(
              localSource,
              folder.folder,
              {
                appName: app_name || defaultAppName(repoUrl!),
                volume,
                why: "Varity cannot read this project's GitHub repository (it is private), so",
                startedAt,
              },
              uploadState
            );
          }
          return errorResponse(err.code, ...unreadableRepository(repoUrl, Boolean(localSource), uploadState));
        }
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? "Check the request and retry.");
        }
        return errorResponse("DEPLOY_FAILED", "The deploy request failed.", "Retry the request.");
      }
    }
  );
}
