import { randomBytes, randomUUID } from "node:crypto";
import { errorResponse, successResponse } from "../utils/responses.js";
import {
  commitHostedChange,
  createDeployment,
  createHostedRepository,
  VarityPublicApiError,
  type HostedChangeFile,
  type HostedRepository,
} from "../utils/public-api.js";
import { acceptanceSummary, lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";
import type { CollectedFolder } from "./pack.js";

/**
 * The private-copy deploy of a local folder (PLAN-R1 M3): when the upload
 * route is unavailable, the collected files are saved to a private
 * repository Varity keeps for this owner (gateway `POST
 * /api/github/hosted-repositories`, idempotent by name), committed in fenced
 * chunks on a fresh `varity/` branch (`POST /api/github/changes`), and the
 * app is deployed from the exact last commit. Every limit is checked before
 * the first network call, so a folder that can never fit spends no budget.
 * Reads no file: the stdio local source collects the folder.
 */

/** Gateway per-change limits (services/github-changes.ts MAX_FILES, MAX_TOTAL_BYTES) and the MCP's own caps. */
export const PRIVATE_COPY_LIMITS = {
  maxFiles: 500,
  maxTotalBytes: 5_000_000,
  maxFileBytes: 1_000_000,
  commitFiles: 50,
  commitBytes: 1_000_000,
  /** Keeps one commit's sequential blob writes inside the gateway's 24 s GitHub budget. */
  commitBase64Files: 20,
  /** `2 + 3 x commits + base64 files` must fit the per-minute key budget (60), so also the hourly one (150). */
  maxUnits: 60,
  /** No commit starts after this (claude.ai cuts a tool call at 240 s). */
  commitDeadlineMs: 170_000,
  /** No deploy starts after this. */
  deployDeadlineMs: 200_000,
} as const;

const NOTHING = "Nothing was deployed or charged.";
const AGAIN = "Call varity_deploy again with the same path.";
const TOO_LARGE_ACTION = "Add large media, data or build folders to .gitignore, then call varity_deploy again with the same path.";
const MB = 1_000_000;

type ToolResult = ReturnType<typeof errorResponse> | ReturnType<typeof successResponse>;

/** UTF-8 when the bytes round-trip and hold no NUL; otherwise base64 of the exact bytes. */
function encode(path: string, data: Buffer): HostedChangeFile & { bytes: number } {
  const text = data.toString("utf8");
  const utf8 = !data.includes(0) && Buffer.from(text, "utf8").equals(data);
  return utf8
    ? { path, content: text, encoding: "utf-8", bytes: data.length }
    : { path, content: data.toString("base64"), encoding: "base64", bytes: data.length };
}

/** At most 50 files, 1,000,000 bytes and 20 base64 files per commit, in walk order. */
function chunk(files: Array<HostedChangeFile & { bytes: number }>): HostedChangeFile[][] {
  const chunks: Array<Array<HostedChangeFile & { bytes: number }>> = [];
  let bytes = 0;
  let base64 = 0;
  for (const file of files) {
    const current = chunks[chunks.length - 1];
    const b64 = file.encoding === "base64" ? 1 : 0;
    if (
      !current ||
      current.length === PRIVATE_COPY_LIMITS.commitFiles ||
      bytes + file.bytes > PRIVATE_COPY_LIMITS.commitBytes ||
      base64 + b64 > PRIVATE_COPY_LIMITS.commitBase64Files
    ) {
      chunks.push([file]);
      bytes = file.bytes;
      base64 = b64;
    } else {
      current.push(file);
      bytes += file.bytes;
      base64 += b64;
    }
  }
  return chunks.map((files) => files.map(({ path, content, encoding }) => ({ path, content, encoding })));
}

function tooLarge(why: string) {
  return errorResponse("FOLDER_TOO_LARGE_FOR_VARITY", `${why} ${NOTHING}`, TOO_LARGE_ACTION);
}

function incomplete() {
  return errorResponse(
    "FOLDER_SAVE_INCOMPLETE",
    `Varity stopped before this folder was completely saved, so nothing was deployed or charged.`,
    AGAIN
  );
}

/** 429/503: the served Retry-After as a Varity action. */
function busy(err: VarityPublicApiError) {
  return errorResponse(
    err.code,
    `${err.message} ${NOTHING}`,
    `Call varity_deploy again with the same path after ${err.retryAfterSeconds ?? 60} seconds.`
  );
}

function refused(err: VarityPublicApiError, files: HostedChangeFile[]) {
  if (err.status === 429 || err.status === 503) return busy(err);
  if (err.code === "secret_path_refused") {
    const index = /^files\[(\d+)\]/.exec(typeof err.served?.field === "string" ? err.served.field : "")?.[1];
    const path = index !== undefined ? files[Number(index)]?.path : undefined;
    return errorResponse(
      err.code,
      `Varity refused to save ${path ?? "a file"} because it looks like a secret. ${NOTHING}`,
      "Move it out of the project folder or add it to .gitignore, set its values with varity_set_env, then call varity_deploy again with the same path."
    );
  }
  return errorResponse(err.code, `${err.message} ${NOTHING}`, AGAIN);
}

/** A 504 the gateway says wrote something, or any answer after a resend that could follow a partial write. */
const LANDED = /\blanded\b|ran out of time after/i;
const unlanded = (err: VarityPublicApiError) =>
  err.code === "VARITY_API_UNREACHABLE" || (err.status === 504 && !LANDED.test(err.message));

/** `varity/mcp-20261118T061756Z-a1b2c3`: a new branch per run. */
function runBranch(): string {
  const utc = new Date(Date.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `varity/mcp-${utc}-${randomBytes(3).toString("hex")}`;
}

/**
 * Deploys `collected` as a private copy. Answers null when the hosted route is
 * unavailable (404, or 403 `repo_authority_required` on create): nothing was
 * created, and the caller gives its existing no-folder copy.
 */
export async function deployPrivateCopy(
  collected: CollectedFolder,
  request: Record<string, unknown>,
  why: string,
  startedAt: number
): Promise<ToolResult | null> {
  const L = PRIVATE_COPY_LIMITS;
  if (collected.files.length > L.maxFiles) {
    return tooLarge(`This folder has ${collected.files.length} files to save; Varity keeps at most ${L.maxFiles} for a folder deploy.`);
  }
  const big = collected.files.find((file) => file.data.length > L.maxFileBytes);
  if (big) {
    return tooLarge(`${big.path} is ${(big.data.length / MB).toFixed(1)} MB; Varity keeps files of at most ${L.maxFileBytes / MB} MB for a folder deploy.`);
  }
  if (collected.uncompressedBytes > L.maxTotalBytes) {
    return tooLarge(`This folder holds ${(collected.uncompressedBytes / MB).toFixed(1)} MB of files; Varity keeps at most ${L.maxTotalBytes / MB} MB for a folder deploy.`);
  }
  const encoded = collected.files.map((file) => encode(file.path, file.data));
  const commits = chunk(encoded);
  const binary = encoded.filter((file) => file.encoding === "base64").length;
  const units = 2 + 3 * commits.length + binary;
  if (units > L.maxUnits) {
    return tooLarge(`This folder has ${binary} binary files (images, fonts, media), more than Varity saves in one folder deploy.`);
  }

  let repo: HostedRepository;
  try {
    repo = await createHostedRepository(String(request.app_name));
  } catch (err) {
    if (!(err instanceof VarityPublicApiError)) return errorResponse("FOLDER_SAVE_FAILED", `Varity could not start saving this folder. ${NOTHING}`, AGAIN);
    if (err.status === 404 || (err.status === 403 && err.code === "repo_authority_required")) return null;
    if (err.code === "hosted_repository_name_in_use") {
      return errorResponse(err.code, `${err.message} ${NOTHING}`, "Call varity_deploy again with a different app_name.");
    }
    return refused(err, []);
  }

  const run = randomUUID();
  const branch = runBranch();
  let head: string | undefined;
  for (const [i, files] of commits.entries()) {
    if (Date.now() - startedAt > L.commitDeadlineMs) return incomplete();
    const change = {
      repo: { owner: repo.owner, name: repo.name },
      base_ref: repo.default_branch || "main",
      branch,
      ...(head ? { expected_head_sha: head } : {}),
      message: commits.length > 1 ? `Save folder from Varity MCP (${i + 1}/${commits.length})` : "Save folder from Varity MCP",
      files,
      open_pr: false as const,
    };
    const key = `mcp-change:${run}:${i}`;
    try {
      head = (await commitHostedChange(change, key)).commit_sha;
    } catch (err) {
      if (!(err instanceof VarityPublicApiError)) return incomplete();
      if (!unlanded(err)) return err.status === 504 ? incomplete() : refused(err, files);
      // Nothing landed: one resend of the same key replays or completes it.
      try {
        head = (await commitHostedChange(change, key)).commit_sha;
      } catch (again) {
        if (
          !(again instanceof VarityPublicApiError) ||
          unlanded(again) ||
          again.status === 504 ||
          again.code === "branch_exists" ||
          again.code === "head_moved"
        ) {
          return incomplete();
        }
        return refused(again, files);
      }
    }
  }
  if (Date.now() - startedAt > L.deployDeadlineMs) return incomplete();

  let accepted: Awaited<ReturnType<typeof createDeployment>>;
  try {
    accepted = await createDeployment({ ...request, repo_url: `https://github.com/${repo.full_name}`, commit: head });
  } catch (err) {
    if (err instanceof VarityPublicApiError) {
      return errorResponse(err.code, `Varity saved this folder, but the deploy was not started: ${err.message}`, err.action ?? AGAIN);
    }
    return errorResponse("DEPLOY_FAILED", "Varity saved this folder, but the deploy was not started.", AGAIN);
  }
  const acceptance = await lifecycleAcceptance(accepted);
  const secrets = collected.secretPaths;
  const parts = [
    `${collected.files.length} files`,
    collected.excludedCount > 0 ? `left out ${collected.excludedCount} ignored` : "",
    secrets.length > 0 ? `kept secret files ${secrets.join(", ")} on this computer` : "",
  ].filter(Boolean);
  return successResponse(
    {
      accepted: true,
      id: accepted.id ?? null,
      app_name: accepted.app_name ?? null,
      source: "varity_private_repository",
      saved_files: collected.files.length,
      left_out_count: collected.excludedCount,
      secret_files_not_saved: secrets,
      ...acceptance,
    },
    `${why ? `${why} ` : ""}Varity saved a private copy of this folder (${parts.join("; ")}) and is building it. ` +
      (secrets.length > 0 ? "Give the app its settings with varity_set_env. " : "") +
      acceptanceSummary("Deploy", accepted.id, acceptance)
  );
}
