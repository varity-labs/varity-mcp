import { randomBytes, randomUUID } from "node:crypto";
import { errorResponse, successResponse } from "../utils/responses.js";
import {
  CHAT_AND_BUILD_URL,
  commitHostedChange,
  createDeployment,
  createHostedRepository,
  hostedRouteUnavailable,
  PUBLIC_API_GET_TIMEOUT_MS,
  VarityPublicApiError,
  type HostedChange,
  type HostedChangeFile,
} from "../utils/public-api.js";
import { acceptanceSummary, checkStatusAction, lifecycleAcceptance, startUnconfirmed } from "../utils/lifecycle-acceptance.js";
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
  /** The gateway's `org_keys:minute` (gw #1099); a folder deploy is paced across at most `pacedWindows` of them. */
  keyUnitsPerMinute: 23,
  /**
   * Fixed minute windows start every 60 s, so from the run start the 3rd boundary may fall after
   * the 170 s commit deadline: a run can count on the current window and the next two (3 x 23 = 69
   * units). This sizes the preflight; it does not guarantee delivery (a run that misses the
   * deadline answers FOLDER_SAVE_INCOMPLETE and the next call starts a fresh run).
   */
  pacedWindows: 3,
  /** Paced waits per send (#1099 SP30-2): the create, and each commit attempt (its one resend has its own); each resend counts toward the per-actor change limit. */
  maxPacedWaits: 3,
  /** No commit starts after this (claude.ai cuts a tool call at 240 s). */
  commitDeadlineMs: 170_000,
  /** No deploy starts after this. */
  deployDeadlineMs: 200_000,
  /** No request runs past this: each one's timeout is cut to what is left (claude.ai's 240 s, less a margin). */
  hardDeadlineMs: 230_000,
  /** Shown when a 429/503 carries no Retry-After. */
  defaultRetryAfterSeconds: 60,
} as const;

/** One folder deploy: what `varity_deploy` asked for, why the folder is sent, and when the call began. */
export interface FolderDeploy {
  appName: string;
  /** `volume_size_gb` / `volume_path` when the caller set them. */
  volume: Record<string, unknown>;
  /** The lead-in sentence ("This project has no GitHub repository, so"), or "". */
  why: string;
  /** `Date.now()` when the tool call began; every deadline counts from it. */
  startedAt: number;
}

/** The one wait of a paced run (PLAN-2.3.30 §2.11); tests replace it to advance a fake clock. */
export const pacing = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

const NOTHING = "Nothing was deployed or charged.";
const AGAIN = "Call varity_deploy again with the same path.";
const TOO_LARGE_ACTION =
  "Add large media, data or build folders to .gitignore and call varity_deploy again with the same path; or put it on Varity another way: " +
  `describe the app in Varity's Chat and Build (${CHAT_AND_BUILD_URL}), deploy a ready-made template (varity_list_templates), ` +
  "or deploy a prebuilt container image (image argument).";
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

/** Minute windows a run's requests need, packed greedily in send order. */
function windowsNeeded(units: number[], perWindow: number): number {
  let windows = 0;
  let room = 0;
  for (const unit of units) {
    if (unit > perWindow) return Infinity;
    if (unit > room) {
      windows += 1;
      room = perWindow;
    }
    room -= unit;
  }
  return windows;
}

function tooLarge(why: string) {
  return errorResponse("FOLDER_TOO_LARGE_FOR_VARITY", `${why} ${NOTHING}`, TOO_LARGE_ACTION);
}

/** `retryAfterSeconds`: the served wait of the 429 that stopped the save, when that was the cause. */
function incomplete(retryAfterSeconds?: number) {
  return errorResponse(
    "FOLDER_SAVE_INCOMPLETE",
    `Varity stopped before this folder was completely saved, so nothing was deployed or charged.`,
    retryAfterSeconds === undefined ? AGAIN : `Call varity_deploy again with the same path after ${retryAfterSeconds} seconds.`
  );
}

/** 429/503: the served Retry-After as a Varity action. */
function busy(err: VarityPublicApiError, lead = "") {
  return errorResponse(
    err.code,
    `${lead}${err.message} ${NOTHING}`,
    `Call varity_deploy again with the same path after ${err.retryAfterSeconds ?? PRIVATE_COPY_LIMITS.defaultRetryAfterSeconds} seconds.`
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

/** A request's timeout: the default, cut to what is left before `deadlineAt` (ms since epoch). */
function timeoutBefore(deadlineAt: number): number {
  return Math.min(PUBLIC_API_GET_TIMEOUT_MS, deadlineAt - Date.now());
}

/**
 * What a failed commit allows (VERIFY-R1 E9), from the served code only:
 * - "resend": nothing landed, so the same key is sent once more. A network
 *   failure, or the gateway's `github_deadline_exceeded`: its only 504 that
 *   wrote something is the pull-request step (github-changes.ts
 *   `landedPastDeadline`), which `open_pr: false` never reaches.
 * - "incomplete": a write may be partial, so nothing more is sent: any other
 *   504, and a fenced `branch_exists`/`head_moved` (only a resend meets one).
 * - "refused": the gateway's own refusal.
 */
function classify(err: unknown): "resend" | "incomplete" | "refused" {
  if (!(err instanceof VarityPublicApiError)) return "incomplete";
  if (err.code === "VARITY_API_UNREACHABLE" || (err.status === 504 && err.code === "github_deadline_exceeded")) return "resend";
  if (err.status === 504 || err.code === "branch_exists" || err.code === "head_moved") return "incomplete";
  return "refused";
}

/** What a paced send ended on: its value, or the error that ended it. */
type Sent<T> = { value: T } | { err: unknown };

/** Thrown in place of a request when no time is left before the hard deadline. */
const OUT_OF_TIME = new Error("No time left before the hard deadline.");

/**
 * #1099 pacing: a 429 with a Retry-After is waited out and the same request
 * sent again. The gateway refuses a budget before any GitHub write and stores
 * no replay for a failure, so the same Idempotency-Key is processed fresh.
 * Each wait is the Retry-After plus 1 s (past the window's end) plus 0-3 s of
 * jitter (so paced keys do not all wake at the boundary); one send waits at
 * most `maxPacedWaits` times, and only while the wait ends by the commit
 * deadline. That deadline is read on the clock the waits advance, so a sleep
 * that returns early still counts its whole wait and the loop always ends.
 * A 503, a 429 without Retry-After, or a wait that does not fit ends it.
 */
async function withPacing<T>(send: () => Promise<T>, startedAt: number): Promise<Sent<T>> {
  const deadlineAt = startedAt + PRIVATE_COPY_LIMITS.commitDeadlineMs;
  let waits = 0;
  let wokeAt = 0;
  while (true) {
    try {
      return { value: await send() };
    } catch (err) {
      if (!(err instanceof VarityPublicApiError) || err.status !== 429 || err.retryAfterSeconds === undefined) return { err };
      const waitMs = (err.retryAfterSeconds + 1) * 1000 + Math.floor(Math.random() * 3000);
      const now = Math.max(Date.now(), wokeAt);
      if (waits === PRIVATE_COPY_LIMITS.maxPacedWaits || now + waitMs > deadlineAt) return { err };
      waits += 1;
      wokeAt = now + waitMs;
      await pacing.sleep(waitMs);
    }
  }
}

/**
 * One commit, paced, with at most one resend of the same key after a network
 * or unlanded 504 failure. No attempt starts without time left before the
 * hard deadline, and none runs past it. Answers the new head sha, or the
 * error that ended the commit (`commitFailure` says what it means).
 */
async function commitOnce(change: HostedChange, key: string, startedAt: number): Promise<Sent<string>> {
  const deadlineAt = startedAt + PRIVATE_COPY_LIMITS.hardDeadlineMs;
  const attempt = () =>
    withPacing(() => {
      const timeoutMs = timeoutBefore(deadlineAt);
      return timeoutMs > 0 ? commitHostedChange(change, key, timeoutMs) : Promise.reject(OUT_OF_TIME);
    }, startedAt);
  let sent = await attempt();
  if ("err" in sent && classify(sent.err) === "resend") sent = await attempt();
  return "value" in sent ? { value: sent.value.commit_sha } : sent;
}

/**
 * What a failed commit answers: the gateway's own refusal (a 429 or 503 before
 * any commit landed is busy with its wait), else incomplete; a 429 after a
 * commit landed is incomplete too, because part of the folder is saved.
 */
function commitFailure(err: unknown, files: HostedChangeFile[], landed: boolean): ToolResult {
  if (!(err instanceof VarityPublicApiError) || classify(err) !== "refused") return incomplete();
  return landed && err.status === 429 ? incomplete(err.retryAfterSeconds) : refused(err, files);
}

/** The create's own refusal: null when the hosted route is unavailable (the caller's no-folder copy). */
function createRefused(err: unknown): ToolResult | null {
  if (!(err instanceof VarityPublicApiError)) return errorResponse("FOLDER_SAVE_FAILED", `Varity could not start saving this folder. ${NOTHING}`, AGAIN);
  if (hostedRouteUnavailable(err)) return null;
  if (err.code === "hosted_repository_name_in_use") {
    return errorResponse(err.code, `${err.message} ${NOTHING}`, "Call varity_deploy again with a different app_name.");
  }
  return refused(err, []);
}

/** `varity/mcp-20261118T061756Z-a1b2c3`: a new branch per run. */
function runBranch(): string {
  const utc = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `varity/mcp-${utc}-${randomBytes(3).toString("hex")}`;
}

/**
 * Deploys `collected` as a private copy. Answers null when the hosted route is
 * unavailable (`hostedRouteUnavailable` on create): nothing was created, and
 * the caller gives its existing no-folder copy.
 */
export async function deployPrivateCopy(collected: CollectedFolder, deploy: FolderDeploy): Promise<ToolResult | null> {
  const limits = PRIVATE_COPY_LIMITS;
  if (collected.files.length > limits.maxFiles) {
    return tooLarge(`This folder has ${collected.files.length} files to save; Varity keeps at most ${limits.maxFiles} for a folder deploy.`);
  }
  const big = collected.files.find((file) => file.data.length > limits.maxFileBytes);
  if (big) {
    return tooLarge(`${big.path} is ${(big.data.length / MB).toFixed(1)} MB; Varity keeps files of at most ${limits.maxFileBytes / MB} MB for a folder deploy.`);
  }
  if (collected.uncompressedBytes > limits.maxTotalBytes) {
    return tooLarge(`This folder holds ${(collected.uncompressedBytes / MB).toFixed(1)} MB of files; Varity keeps at most ${limits.maxTotalBytes / MB} MB for a folder deploy.`);
  }
  const encoded = collected.files.map((file) => encode(file.path, file.data));
  const commits = chunk(encoded);
  // The create (2, even when it re-finds the repository), then each commit (3 + its base64 files).
  const units = [2, ...commits.map((files) => 3 + files.filter((file) => file.encoding === "base64").length)];
  // The estimate grows with the number of saves and with binary files, so the text blames neither.
  if (windowsNeeded(units, limits.keyUnitsPerMinute) > limits.pacedWindows) {
    return tooLarge("This folder needs more saves than one folder deploy allows.");
  }

  const created = await withPacing(() => createHostedRepository(deploy.appName), deploy.startedAt);
  if ("err" in created) return createRefused(created.err);
  const repo = created.value;

  const run = randomUUID();
  const branch = runBranch();
  let head: string | undefined;
  for (const [i, files] of commits.entries()) {
    if (Date.now() - deploy.startedAt > limits.commitDeadlineMs) return incomplete();
    const change: HostedChange = {
      repo: { owner: repo.owner, name: repo.name },
      base_ref: repo.default_branch || "main",
      branch,
      ...(head ? { expected_head_sha: head } : {}),
      message: commits.length > 1 ? `Save folder from Varity MCP (${i + 1}/${commits.length})` : "Save folder from Varity MCP",
      files,
      open_pr: false,
    };
    const committed = await commitOnce(change, `mcp-change:${run}:${i}`, deploy.startedAt);
    if ("err" in committed) return commitFailure(committed.err, files, head !== undefined);
    head = committed.value;
  }
  if (Date.now() - deploy.startedAt > limits.deployDeadlineMs) return incomplete();

  let accepted: Awaited<ReturnType<typeof createDeployment>>;
  try {
    accepted = await createDeployment(
      { app_name: deploy.appName, ...deploy.volume, repo_url: `https://github.com/${repo.full_name}`, commit: head },
      { timeoutMs: timeoutBefore(deploy.startedAt + limits.hardDeadlineMs) }
    );
  } catch (err) {
    const lead = "Varity saved this folder, but the deploy was not started: ";
    if (err instanceof VarityPublicApiError) {
      if (startUnconfirmed(err)) {
        return errorResponse(err.code, "Varity saved this folder; whether the deploy started is unconfirmed.", checkStatusAction(deploy.appName));
      }
      if (err.status === 429 || err.status === 503) return busy(err, lead);
      return errorResponse(err.code, `${lead}${err.message}`, err.action ?? AGAIN);
    }
    return errorResponse("DEPLOY_FAILED", "Varity saved this folder, but the deploy was not started.", AGAIN);
  }
  const acceptance = await lifecycleAcceptance(accepted, timeoutBefore(deploy.startedAt + limits.hardDeadlineMs));
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
    `${deploy.why ? `${deploy.why} ` : ""}Varity saved a private copy of this folder (${parts.join("; ")}) and is building it. ` +
      (secrets.length > 0 ? "Give the app its settings with varity_set_env. " : "") +
      acceptanceSummary("Deploy", accepted.id, acceptance)
  );
}
