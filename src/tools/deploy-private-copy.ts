import { randomBytes, randomUUID } from "node:crypto";
import { errorResponse, successResponse } from "../utils/responses.js";
import {
  CHAT_AND_BUILD_URL,
  commitHostedChange,
  createDeployment,
  createDeploymentApproval,
  createHostedRepository,
  deploySourceRevision,
  getDeployment,
  hostedRouteUnavailable,
  PUBLIC_API_GET_TIMEOUT_MS,
  VarityPublicApiError,
  type HostedChange,
  type HostedChangeFile,
  type PublicDeployment,
  type PublicRunAcceptance,
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
 *
 * PLAN-W2: the app is looked up first. A same-name create replaces a dynamic
 * app's sealed settings and drops an attached AI key (gateway public-api.ts
 * create, deploy-api `_select_create_deployment`), so a dynamic app this copy
 * already runs is updated in place by an approved source revision, which keeps
 * them; a first deploy, a static app or one that never went live is created.
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
  /**
   * The source revision starts only with this much left before the hard deadline: the gateway's own
   * worst case is the clone-token mint (8 s), the anonymous clone probe (5 s) and deploy-api (15 s),
   * plus its ownership and approval reads (PLAN-W2 §3.1, VERIFIER-W2 finding 8).
   */
  revisionMinLeftMs: 45_000,
  /** An ambiguous source revision is resent (same key, new approval) only with this much left. */
  resendMinLeftMs: 15_000,
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

/**
 * The name a create routes the app under: the gateway's own app-name
 * normalization (`sanitizeSubdomain`, services/varity-gateway
 * src/services/deploy-validation.ts:26-41 at 98042b77), so the app is looked
 * up where the create would land.
 */
export function locatorName(name: string): string {
  const trimmed = name.trim();
  const last = trimmed.includes("/") ? trimmed.split("/").pop() || trimmed : trimmed;
  return last.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

/** The served code of a failure, or the client's own code when nothing was served. */
function codeOf(err: unknown): string {
  return err instanceof VarityPublicApiError ? err.code : "VARITY_API_UNREACHABLE";
}

/** How the saved folder is deployed (PLAN-W2 §3.1). */
type Target = { kind: "create" } | { kind: "revision"; id: string; repositoryUrl: string };

function nameInUse(appName: string) {
  return errorResponse(
    "APP_NAME_IN_USE",
    `An app named ${appName} already runs on Varity from another source; deploying this folder under that name would replace it and drop its settings. ${NOTHING}`,
    "Call varity_deploy again with the same path and a different app_name."
  );
}

/**
 * Which deploy keeps what the app already has, read from the owner-scoped
 * locator before anything is saved. Only the gateway's own
 * `deployment_not_found` means there is no such app: any other answer that
 * could not be read refuses (R8), because a create would drop a live app's
 * settings.
 */
async function deployTarget(deploy: FolderDeploy): Promise<Target | ToolResult> {
  const name = locatorName(deploy.appName);
  // The create refuses such a name itself (400); there is nothing to look up.
  if (name.length < 3) return { kind: "create" };
  let app: PublicDeployment;
  try {
    app = await getDeployment(name, timeoutBefore(deploy.startedAt + PRIVATE_COPY_LIMITS.hardDeadlineMs));
  } catch (err) {
    if (err instanceof VarityPublicApiError && err.status === 404 && err.code === "deployment_not_found") return { kind: "create" };
    if (err instanceof VarityPublicApiError && (err.status === 429 || err.status === 503)) return busy(err);
    return errorResponse(
      codeOf(err),
      `Varity could not check whether ${deploy.appName} already exists, so nothing was deployed or charged.`,
      AGAIN
    );
  }
  if (app.deleted_at || app.status === "deleting" || app.status === "deleted") {
    return errorResponse(
      "APP_BEING_DELETED",
      `${deploy.appName} is still being deleted on Varity. ${NOTHING}`,
      `Call varity_deploy_status with "${deploy.appName}" until it shows deleted, then call varity_deploy again with the same path.`
    );
  }
  // Never went live: no saved settings or attached key exist yet.
  if (app.membership === "durable_only" || app.runtime === "static") return { kind: "create" };
  if (app.runtime === "dynamic" && app.membership !== "registry_legacy" && app.source?.type === "repository") {
    const url = app.source.repository_url;
    if (typeof url === "string" && url) {
      // Only a GitHub repository can be this private copy; any other source is another app.
      return githubRepository(url) ? { kind: "revision", id: app.id, repositoryUrl: url } : nameInUse(deploy.appName);
    }
    return errorResponse(
      "DEPLOYMENT_SOURCE_UNCONFIRMED",
      `Varity could not confirm what ${deploy.appName} is running from right now, so nothing was deployed or charged.`,
      "Call varity_deploy again with the same path in a minute."
    );
  }
  return nameInUse(deploy.appName);
}

/** `owner/name` (lowercase) of a served `https://github.com/<owner>/<name>` (`.git` ignored), else null. */
function githubRepository(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function sameRepository(url: string, fullName: string): boolean {
  return githubRepository(url) === fullName.toLowerCase();
}

const NOT_STARTED = "Varity saved this folder, but the update was not started: ";
const LIVE_APP_KEPT = "The live app was not changed.";

/**
 * The gateway may have accepted the update: a network failure, a 500, the 503 that says deploy-api
 * did not answer, and also a 502/504 (an edge answer that hides whether the route ran), so a lost
 * answer is never reported as "not started" (R8).
 */
function ambiguous(err: unknown): boolean {
  if (!(err instanceof VarityPublicApiError)) return true;
  if (err.code === "VARITY_API_UNREACHABLE" || err.status === undefined) return true;
  // A 503 with no served code (an edge answer, `VARITY_API_ERROR`) is ambiguous too.
  return err.status === 500 || err.status === 502 || err.status === 504 ||
    (err.status === 503 && (err.code === "deploy_service_unavailable" || err.code === "VARITY_API_ERROR"));
}

function unconfirmed(err: unknown, appName: string): ToolResult {
  return errorResponse(
    codeOf(err),
    "Varity saved this folder; whether the update started is unconfirmed.",
    checkStatusAction(appName)
  );
}

/** Refusals after which the live app keeps running unchanged (gateway source-revision route). */
const LIVE_APP_REFUSALS = new Set(["source_revision_unavailable", "source_revision_refused", "runtime_not_started", "source_revision_unsupported", "deployment_not_found"]);

/** A source revision the gateway refused (never an ambiguous answer): no create follows. */
function revisionRefused(err: VarityPublicApiError, appName: string): ToolResult {
  if (err.status === 429 || err.status === 503) return busy(err, NOT_STARTED);
  if (err.code === "deployment_update_in_progress") {
    return errorResponse(
      err.code,
      `${NOT_STARTED}Another update of this app is still running.`,
      `Wait until varity_deploy_status with "${appName}" shows it live, then call varity_deploy again with the same path.`
    );
  }
  if (err.code === "repository_credential_required") {
    return errorResponse(
      err.code,
      `${NOT_STARTED}Varity could not get read access to this app's private copy right now. ${LIVE_APP_KEPT}`,
      "Call varity_deploy again with the same path in a minute; if it repeats, call varity_doctor to check the deploy key."
    );
  }
  if (LIVE_APP_REFUSALS.has(err.code)) {
    return errorResponse(
      err.code,
      `${NOT_STARTED}${err.message} ${LIVE_APP_KEPT}`,
      `Call varity_deploy_status with "${appName}" to see its state; to deploy this folder as a separate app, call varity_deploy again with the same path and a different app_name.`
    );
  }
  return errorResponse(err.code, `${NOT_STARTED}${err.message}`, AGAIN);
}

type Revision = { value: PublicRunAcceptance } | { approvalErr: unknown } | { err: unknown };

/** One approval for exactly this update, then the source revision under the run's one key. */
async function approvedRevision(id: string, commit: string, key: string, hardAt: number): Promise<Revision> {
  let approvalId: string;
  try {
    approvalId = await createDeploymentApproval(
      { kind: "deploy_revision", target: `deployment:${id}`.toLowerCase(), fingerprint: commit },
      timeoutBefore(hardAt)
    );
  } catch (err) {
    return { approvalErr: err };
  }
  try {
    return { value: await deploySourceRevision(id, commit, approvalId, key, timeoutBefore(hardAt)) };
  } catch (err) {
    return { err };
  }
}

/**
 * The in-place update (gateway `POST /api/deployments/:id/source-revision`).
 * An ambiguous answer is resent once with the same Idempotency-Key and a new
 * approval: the gateway replays a stored answer, deploy-api the same run. Any
 * other answer to that resend, even a refusal, cannot prove the first one did
 * not start (a re-minted clone token changes deploy-api's request hash), so it
 * is unconfirmed, never "not started".
 */
async function updateInPlace(id: string, commit: string, deploy: FolderDeploy): Promise<{ value: PublicRunAcceptance } | ToolResult> {
  const hardAt = deploy.startedAt + PRIVATE_COPY_LIMITS.hardDeadlineMs;
  if (hardAt - Date.now() < PRIVATE_COPY_LIMITS.revisionMinLeftMs) {
    return errorResponse("DEPLOY_NOT_STARTED", `Varity saved this folder, but there was not enough time left to start the update. ${NOTHING}`, AGAIN);
  }
  const key = `mcp-source-revision:${randomUUID()}`;
  const first = await approvedRevision(id, commit, key, hardAt);
  if ("value" in first) return first;
  if ("approvalErr" in first) {
    const err = first.approvalErr;
    if (err instanceof VarityPublicApiError && (err.status === 429 || err.status === 503)) return busy(err, NOT_STARTED);
    return errorResponse(
      codeOf(err),
      `${NOT_STARTED}${err instanceof Error ? err.message : "the approval failed."}`,
      AGAIN
    );
  }
  if (!ambiguous(first.err)) return revisionRefused(first.err as VarityPublicApiError, deploy.appName);
  if (hardAt - Date.now() < PRIVATE_COPY_LIMITS.resendMinLeftMs) return unconfirmed(first.err, deploy.appName);
  const resent = await approvedRevision(id, commit, key, hardAt);
  if ("value" in resent) return resent;
  return unconfirmed("err" in resent ? resent.err : resent.approvalErr, deploy.appName);
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

  const target = await deployTarget(deploy);
  if (!("kind" in target)) return target;

  const created = await withPacing(() => createHostedRepository(deploy.appName), deploy.startedAt);
  if ("err" in created) return createRefused(created.err);
  const repo = created.value;
  if (target.kind === "revision" && !sameRepository(target.repositoryUrl, repo.full_name)) return nameInUse(deploy.appName);

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

  const secrets = collected.secretPaths;
  const saved = [
    `${collected.files.length} files`,
    collected.excludedCount > 0 ? `left out ${collected.excludedCount} ignored` : "",
    secrets.length > 0 ? `kept secret files ${secrets.join(", ")} on this computer` : "",
  ].filter(Boolean).join("; ");
  const savedData = { source: "varity_private_repository", saved_files: collected.files.length, left_out_count: collected.excludedCount, secret_files_not_saved: secrets };
  const lead = deploy.why ? `${deploy.why} ` : "";

  if (target.kind === "revision") {
    const updated = await updateInPlace(target.id, head!, deploy);
    if (!("value" in updated)) return updated;
    const acceptance = await lifecycleAcceptance(updated.value, timeoutBefore(deploy.startedAt + limits.hardDeadlineMs));
    return successResponse(
      { accepted: true, id: updated.value.id ?? null, app_name: updated.value.app_name ?? null, ...savedData, update: "in_place", ...acceptance },
      `${lead}Varity saved a private copy of this folder (${saved}) and is updating ${deploy.appName} in place; its settings and any attached AI key are kept. ` +
        (Object.keys(deploy.volume).length > 0 ? "Its storage settings are unchanged. " : "") +
        acceptanceSummary("Deploy", updated.value.id, acceptance)
    );
  }

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
  return successResponse(
    { accepted: true, id: accepted.id ?? null, app_name: accepted.app_name ?? null, ...savedData, ...acceptance },
    `${lead}Varity saved a private copy of this folder (${saved}) and is building it. ` +
      (secrets.length > 0 ? "Give the app its settings with varity_set_env. " : "") +
      acceptanceSummary("Deploy", accepted.id, acceptance)
  );
}
