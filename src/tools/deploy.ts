import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  createDeployment,
  createUploadDeployment,
  createUploadSource,
  uploadSourceArchive,
  CHAT_AND_BUILD_URL,
  VarityPublicApiError,
} from "../utils/public-api.js";
import { acceptanceSummary, lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";
import type { PackedFolder } from "./pack.js";

/**
 * `varity_deploy` → `POST /api/deployments` through the one public-API client
 * (no CLI subprocess). The body is the same public create contract
 * the CLI sends (`app_name`, `repo_url` | `image`, `port`, `volume_*`); the
 * control plane owns framework detection, hosting, build and lifecycle. The
 * MCP only names the source: an explicit repo/image, else (stdio only) the
 * project's `origin` remote through the injected `LocalSource`. A folder with
 * no public GitHub repo (no `origin`, or one Varity cannot read) is packed and
 * uploaded through IF-UPLOAD (`POST /api/deployments/sources`, then a PUT of
 * the archive, then a create naming the sealed `source_id`); the code stays
 * private and nothing is pushed to GitHub. The remote toolset registers this
 * tool without a local source, so its schema has no `path` and this module
 * reads no file.
 */

/** A project folder, its `origin` remote, and its packer; stdio only (`deploy-local-source.ts`). */
export interface LocalSource {
  resolve(
    path: string | undefined
  ): Promise<{ folder: string; repoUrl: string | null; explicit: boolean } | ReturnType<typeof errorResponse>>;
  /** Throws `PackRefused` with plain copy when the folder cannot be uploaded. */
  pack(folder: string): Promise<PackedFolder>;
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

const NO_FOLDER_YET = "Varity can't take a folder from this computer yet.";
const NO_GITHUB_PATH =
  `The way to get a site online today without GitHub is Varity's Chat and Build: describe the app, and Varity builds it ` +
  `and publishes it to a live address. No GitHub needed: ${CHAT_AND_BUILD_URL}`;
const CHAT_AND_BUILD_LINE =
  "The way to get it online today without GitHub is Varity's Chat and Build: describe the app, and Varity builds it " +
  `and publishes it to a live address: ${CHAT_AND_BUILD_URL}`;
/**
 * The error message itself (P1 T3, r3): one quoted paragraph to say verbatim
 * (the pattern that held for sign-in), then the developer options, public
 * GitHub only if asked.
 */
function sayExactly(paragraph: string): string {
  return (
    `Tell the user exactly this: "${paragraph} ${CHAT_AND_BUILD_LINE}" ` +
    "For developers, a ready-made Varity template or a prebuilt container image also works. " +
    "Only if the user asks: make the code public on GitHub and deploy it from there."
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

/** Validator reasons the gateway serves in `field` on 422 `source_archive_refused`, in plain words. */
const ARCHIVE_REFUSALS: Readonly<Record<string, string>> = {
  secret_path: "it contains a file that looks like a secret (a key, credential or .env file)",
  unsafe_path: "a file path points outside the project folder",
  unsupported_entry: "it contains something other than plain files",
  too_many_entries: "it has too many files",
  too_large_uncompressed: "its files are too large in total",
  ratio_exceeded: "its files compress unusually far",
  duplicate_path: "it lists the same path twice",
  empty_archive: "it contains no files",
  unsupported_format: "the archive format was not accepted",
};

/** The gateway route (U-5) or the deploy-api flag is off: nothing was uploaded. */
function uploadUnavailable(err: VarityPublicApiError): boolean {
  if (err.code === "source_not_found") return false;
  return err.status === 404 || err.status === 405 || err.status === 501 || err.code === "uploads_unavailable";
}

const UPLOAD_UNAVAILABLE_ACTION =
  `Tell the user plainly: "${NO_FOLDER_YET} ${NO_GITHUB_PATH}" ` +
  "For developers: a ready-made Varity template (varity_list_templates) or a prebuilt container image (image argument). " +
  "Last, and only if the user decides to make the code public: push it to a public GitHub repository " +
  "(varity_create_repo, then make it public) and deploy its repo_url; ask first.";

function uploadError(err: unknown, step: "upload" | "deploy", state: UploadState) {
  if (!(err instanceof VarityPublicApiError)) {
    return errorResponse("UPLOAD_FAILED", "The folder upload failed, so nothing was deployed or charged.", "Retry the deploy.");
  }
  if ((step === "upload" && uploadUnavailable(err)) || err.code === "uploads_unavailable") {
    state.upload = "unavailable";
    return errorResponse(
      "UPLOAD_UNAVAILABLE",
      sayExactly(`${NO_FOLDER_YET} ${step === "upload" ? "Nothing was uploaded, deployed or charged." : "Nothing was deployed or charged."}`),
      UPLOAD_UNAVAILABLE_ACTION
    );
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

async function deployFolder(
  local: LocalSource,
  folder: string,
  request: Record<string, unknown>,
  why: string,
  state: UploadState
) {
  let packed: PackedFolder;
  try {
    packed = await local.pack(folder);
  } catch (err) {
    const refused = err as { code?: string; message?: string; action?: string };
    if (refused?.code && refused.action) return errorResponse(refused.code, refused.message ?? "", refused.action);
    return errorResponse("PACK_FAILED", `Could not read the project folder ${folder}, so nothing was uploaded.`, "Check the path and file permissions.");
  }
  let sourceId: string;
  try {
    const slot = await createUploadSource();
    if (packed.archive.length > slot.max_bytes) {
      return errorResponse(
        "source_too_large",
        `The packed folder is ${(packed.archive.length / 1024 / 1024).toFixed(1)} MB, over this account's ${Math.floor(slot.max_bytes / 1024 / 1024)} MB upload limit. Nothing was uploaded, deployed or charged.`,
        "Add large generated, media or data folders to .gitignore, then deploy again."
      );
    }
    await uploadSourceArchive(slot, packed.archive);
    state.upload = "available";
    sourceId = slot.source_id;
  } catch (err) {
    return uploadError(err, "upload", state);
  }
  let accepted: Awaited<ReturnType<typeof createUploadDeployment>>;
  try {
    accepted = await createUploadDeployment(request, sourceId);
  } catch (err) {
    return uploadError(err, "deploy", state);
  }
  const acceptance = await lifecycleAcceptance(accepted);
  const secrets = packed.secretPaths;
  const notes = [
    `${why ? `${why} ` : ""}I uploaded this folder to Varity (${packed.fileCount} files); your code stays private and nothing was published to GitHub.`,
    packed.excludedCount > 0
      ? `Left out ${packed.excludedCount} ignored items (dependencies, build output and anything in .gitignore).`
      : "",
    secrets.length > 0
      ? `Kept these secret files on this computer and did not upload them: ${secrets.join(", ")}. Give the app its settings with varity_set_env.`
      : "",
  ].filter(Boolean);
  return successResponse(
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
}

/** The last segment of a local folder path, on any platform. */
function folderName(folder: string): string {
  return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "app";
}

const NEEDS_PATH =
  "Pass path as the absolute path of the project folder (the server's working directory is rarely the project), then deploy again.";

export function registerDeployTool(server: McpServer, localSource?: LocalSource): void {
  const uploadState: UploadState = { upload: "unknown" };
  const pathInput = {
    path: z
      .string()
      .optional()
      .describe(
        "Absolute path to the project directory (e.g. '/home/user/my-app'). " +
        "Used to read the Git `origin` remote when repo_url and image are omitted, and as the folder to try uploading " +
        "when the project has no public GitHub repository. " +
        "If omitted, the MCP server's working directory is used (which is rarely the correct project root)."
      ),
    source: z
      .enum(["upload"])
      .optional()
      .describe(
        "Set to \"upload\" to try sending the project folder at path straight to Varity. " +
        "Tried automatically when the folder has no Git origin remote or its repository is private. " +
        "Folder upload may not be switched on yet: then nothing is uploaded or charged and the answer says so."
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
        "Submit a Git repository, a local project folder, or a prebuilt container image to Varity's deployment owner. " +
        (localSource
          ? "A folder with no public GitHub repository is tried as a direct upload, which Varity may not have switched on yet: " +
            `never promise the upload or private code before it succeeds; if it answers UPLOAD_UNAVAILABLE, ${NO_FOLDER_YET} `
          : "") +
        "The control plane detects the framework, selects hosting, builds, and manages lifecycle state. " +
        "Use this when a developer wants to deploy, publish, ship, or make their app live. " +
        "If the developer wants to deploy a certified template rather than their own code, " +
        "use varity_deploy_template instead. To ship new code for an app that is already deployed, push it and call " +
        "varity_deploy again with the same app_name: the same owner and workload shape updates that app in place at " +
        "the latest commit (varity_redeploy does not pick up new commits). " +
        (localSource ? "For an uploaded folder, call varity_deploy again with the same path and app_name: it uploads the folder again. " : "") +
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
    async ({ path, source, repo_url, app_name, image, port, volume_size, volume_path }: {
      path?: string; source?: "upload"; repo_url?: string; app_name?: string; image?: string; port?: number; volume_size?: number; volume_path?: string;
    }) => {
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
            ? deployFolder(localSource, local.folder, { app_name: app_name || defaultAppName(folderName(local.folder)), ...volume }, why, uploadState)
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
              { app_name: app_name || defaultAppName(repoUrl!), ...volume },
              "Varity cannot read this project's GitHub repository (it is private), so",
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
