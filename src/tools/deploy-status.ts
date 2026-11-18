import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  getDeployment,
  getRun,
  currentCredential,
  getRunBuildLog,
  listDeployments,
  VarityPublicApiError,
  type PublicDeployment,
} from "../utils/public-api.js";
import { redactPublicText } from "../utils/redact.js";

interface DeploymentRecord {
  /** The canonical id: the durable operation id `varity_deploy` returned, stable for the whole life. */
  id: string;
  /** Absent until the owner assigns one; never a placeholder string. */
  url?: string;
  status: string;
  timestamp: string;
  name: string;
  appName: string;
  runtime?: string;
  billing?: Record<string, unknown> | null;
  /** The latest durable run and its sealed outcome, as served (D9). */
  run_id: string | null;
  outcome: unknown;
  /** That run's `public_status`; single-deployment reads only, `null` = unobserved. */
  run_status?: string | null;
  http_probe?: HttpProbe;
}

export interface HttpProbe {
  outcome: "reachable" | "http_error" | "network_error" | "not_applicable";
  http_status?: number;
  latency_ms?: number;
}

export async function checkLiveness(
  url: string | undefined
): Promise<HttpProbe> {
  if (!url || !url.startsWith("http")) {
    return { outcome: "not_applicable" };
  }
  try {
    const start = Date.now();
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    return {
      outcome: res.ok ? "reachable" : "http_error",
      http_status: res.status,
      latency_ms: Date.now() - start,
    };
  } catch {
    return { outcome: "network_error" };
  }
}

export async function applyLiveness(deployments: DeploymentRecord[]): Promise<void> {
  const results = await Promise.all(deployments.map((d) => checkLiveness(d.url)));
  for (let i = 0; i < deployments.length; i++) {
    deployments[i]!.http_probe = results[i]!;
  }
}

/** Served row fields `PublicDeployment` does not type (gateway `PUBLIC_DEPLOYMENT_KEYS`). */
type ServedDeployment = PublicDeployment & { run_id?: string | null; outcome?: unknown };

/** Said wherever a URL would be, while the owner has not assigned one. */
export const URL_PENDING = "URL not assigned yet";

/**
 * A deployment being or already deleted never gets a URL again: a deleted URL
 * returns 404, and "URL not assigned yet" would promise one (J-11, J-13).
 */
function urlRetired(deployment: DeploymentRecord): boolean {
  return deployment.status === "deleted" || deployment.status === "deleting";
}

/** The status and where it serves. */
function servingState(deployment: DeploymentRecord): string {
  if (urlRetired(deployment)) return deployment.status;
  return `${deployment.status}${deployment.url ? ` at ${deployment.url}` : ` (${URL_PENDING})`}`;
}

/** "22 seconds", "3 minutes 5 seconds": elapsed time in plain words. */
export function plainDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (total < 60) return unit(total, "second");
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${unit(minutes, "minute")} ${unit(seconds, "second")}` : unit(minutes, "minute");
}

/**
 * The run's served `stage` (deploy-api `Stage`: accepted, admission, build,
 * allocation, health, access, route, cleanup, terminal) in plain words, with
 * what comes next. An unknown stage gets no words (never guessed).
 */
const STAGE_WORDS: Readonly<Record<string, { now: string; next: string }>> = {
  accepted: { now: "waiting to start", next: "the build starts" },
  admission: { now: "checking the request", next: "the build starts" },
  build: { now: "building your app", next: "Varity finds a server for it and starts it" },
  allocation: { now: "finding a server for your app", next: "Varity starts it and checks that it responds" },
  health: { now: "starting your app on a server and checking that it responds", next: "it gets its web address" },
  access: { now: "setting up access", next: "it gets its web address" },
  route: { now: "giving your app its web address", next: "it is live" },
};

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * While a run is deploying: its stage, elapsed time and what happens next
 * (J-18). `attempt` and `failover_count` are optional run fields the platform
 * is adding; when served they say which try this is and that an earlier
 * server did not respond. Absent fields are simply not mentioned.
 */
export function deployingProgress(run: RunView, now: number = Date.now()): string | null {
  const words = run.stage ? STAGE_WORDS[run.stage] : undefined;
  const started = timeOf(run.accepted_at);
  const elapsed = started !== null ? `${plainDuration(now - started)} so far` : null;
  const attempt = typeof run.attempt === "number" && run.attempt >= 1 ? `attempt ${run.attempt}` : null;
  let text = "";
  if (typeof run.failover_count === "number" && run.failover_count > 0) {
    text += "That server didn't respond, so Varity is trying another one. ";
  }
  if (words && attempt) text += `Now ${words.now} (${[attempt, elapsed].filter(Boolean).join(", ")}).`;
  else if (words) text += `Now ${words.now}${elapsed ? `, ${elapsed}` : ""}.`;
  else if (elapsed || attempt) text += `${[elapsed, attempt].filter(Boolean).join(", ")}.`;
  if (!text) return null;
  if (words) text += ` Next, ${words.next}.`;
  const deadline = timeOf(run.execution_deadline_at);
  if (deadline !== null && deadline > now) {
    text += ` If it is not live by ${new Date(deadline).toISOString().slice(11, 16)} UTC, Varity stops trying and reports why.`;
  }
  return text;
}

/** How long a successful run took from acceptance to its sealed end (J-17). */
export function timeToLive(run: RunView): string | null {
  const started = timeOf(run.accepted_at);
  const outcome = (run.outcome && typeof run.outcome === "object" ? run.outcome : {}) as Record<string, unknown>;
  const ended = timeOf(outcome.terminal_at);
  if (started === null || ended === null || ended < started) return null;
  return `It took ${plainDuration(ended - started)} to go live.`;
}

/** Build error lines the MCP passes on: the last few, redacted again locally. */
export const BUILD_ERROR_LINES = 20;

export interface BuildError {
  stage: string | null;
  lines: string[];
  complete: boolean;
}

/**
 * A failed run's sealed build error from `GET /api/deployments/runs/:id/logs`,
 * last `BUILD_ERROR_LINES` lines, each passed through `redactPublicText` with
 * the configured deploy key as a known secret. `null` when the run recorded
 * none (404) or the read failed: no lines are invented.
 */
export async function readBuildError(runId: string | null): Promise<BuildError | null> {
  if (!runId) return null;
  try {
    const log = await getRunBuildLog(runId);
    const lines = Array.isArray(log.lines) ? log.lines.filter((l): l is string => typeof l === "string") : [];
    if (lines.length === 0) return null;
    const key = await currentCredential();
    const known = key ? [key] : [];
    return {
      stage: typeof log.stage === "string" && log.stage ? log.stage : null,
      lines: lines.slice(-BUILD_ERROR_LINES).map((line) => redactPublicText(line, known)),
      complete: log.complete === true && lines.length <= BUILD_ERROR_LINES,
    };
  } catch {
    return null;
  }
}

/**
 * The served `billing` block with no false zero: `accrued_this_month_usd` is
 * trusted only while `billing.state` is observed. With `state: null` the owner
 * has not measured the interval (an hourly machine, a fresh or legacy row) and
 * serves a placeholder 0, so the MCP says `"unavailable"` instead
 * (journey D F1: a CPU VM read $0 while the portal showed $0.52).
 */
export function truthfulBilling(billing: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!billing) return null;
  if (billing.state != null || !("accrued_this_month_usd" in billing)) return billing;
  return { ...billing, accrued_this_month_usd: "unavailable" };
}

export function normalizeDeployment(item: ServedDeployment): DeploymentRecord {
  const name = item.subdomain ?? item.app_name ?? item.appName ?? item.id;
  const url = item.url ?? item.public_url;
  return {
    // `varity_deploy` returns the operation id; the row id switches from it to
    // a registry id at go-live (journey D F6). Both resolve as input.
    id: item.operation_deployment_id ?? item.id ?? name,
    name,
    appName: item.appName ?? item.app_name ?? name,
    ...(item.runtime ? { runtime: item.runtime } : {}),
    ...(url ? { url } : {}),
    status: item.status ?? "unknown",
    timestamp: item.createdAt ?? item.created_at ?? "unknown",
    billing: truthfulBilling(item.billing),
    run_id: item.run_id ?? null,
    outcome: item.outcome ?? null,
  };
}

/** The run fields the status summary reads; `null` = unobserved. */
export interface RunView {
  status: string | null;
  outcome: unknown;
  stage?: string | null;
  accepted_at?: string | null;
  execution_deadline_at?: string | null;
  /** Optional (not served yet): which try this run is on, and how many servers it has moved past. */
  attempt?: number | null;
  failover_count?: number | null;
}

/**
 * Read the latest run's `public_status`, sealed `outcome`, `stage` and times
 * so a failed run shows why and a running one shows where it is.
 * Unreadable is `null` (unobserved).
 */
export async function readRun(runId: string | null): Promise<RunView> {
  if (!runId) return { status: null, outcome: null };
  try {
    const run = await getRun(runId);
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    return {
      status: text(run.public_status),
      outcome: run.outcome ?? null,
      stage: text(run.stage),
      accepted_at: text(run.accepted_at),
      execution_deadline_at: text(run.execution_deadline_at),
      attempt: typeof run.attempt === "number" ? run.attempt : null,
      failover_count: run.failover && typeof run.failover === "object" && typeof (run.failover as Record<string, unknown>).count === "number"
        ? (run.failover as Record<string, number>).count
        : null,
    };
  } catch {
    return { status: null, outcome: null };
  }
}

async function readDeployments(): Promise<DeploymentRecord[]> {
  const deployments = (await listDeployments()).map(normalizeDeployment);
  return deployments.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * The latest run's terminal outcome when it did not succeed: `run_status:
 * "failed"` or a sealed classification other than `succeeded` (from the row,
 * else the run view). A live deployment keeps its status while a later run
 * (e.g. a refused restart) failed, so the summary says the failure first,
 * with the served codes and action code, never only "live".
 */
export function latestRunFailure(deployment: DeploymentRecord, runOutcome: unknown = null): string | null {
  const served = deployment.outcome ?? runOutcome;
  const outcome = (served && typeof served === "object" ? served : {}) as Record<string, unknown>;
  const classification = typeof outcome.classification === "string" ? outcome.classification : null;
  if (deployment.run_status !== "failed" && (classification === null || classification === "succeeded")) {
    return null;
  }
  const text = (value: unknown): value is string => typeof value === "string" && value !== "" && value !== "succeeded";
  const failure = [classification, outcome.code, outcome.diagnostic_code].filter(text).join(", ");
  const action = text(outcome.action_code) ? `action ${outcome.action_code}` : "";
  const detail = [failure, action].filter(Boolean).join("; ");
  const verb = classification === "cancelled" ? "was cancelled" : "failed";
  return `latest run ${verb}${detail ? ` (${detail})` : ""}`;
}

function apiFailure(err: unknown, action: string) {
  if (err instanceof VarityPublicApiError) {
    return errorResponse(err.code, err.message, err.action ?? action);
  }
  return errorResponse("VARITY_API_ERROR", "Varity API request failed.", action);
}

/**
 * `probe` (stdio only) adds a client-side HTTP reachability probe of each
 * deployment URL. The remote toolset registers without it: on the hosted
 * server that fetch would run from Varity's infrastructure against any URL a
 * deployment row names, so remotely the served status is the only liveness.
 */
export function registerDeployStatusTool(server: McpServer, options: { probe: boolean } = { probe: true }): void {
  const probe = options.probe ? applyLiveness : async () => {};
  server.registerTool(
    "varity_deploy_status",
    {
      title: "Deployment Status",
      description:
        "List deployments or get status of a specific deployment. " +
        "Shows the owner-scoped fields returned by the Varity public interface, including URL, status, runtime when available, and creation time. " +
        (options.probe
          ? "A separate HTTP probe records reachability without overwriting the owner's lifecycle status; authenticated, POST-only, or transiently unavailable apps may return a non-2xx probe. "
          : "Liveness is the platform's served status. ") +
        "Use this when a developer asks about their deployments, wants to check status, " +
        "or needs to find a deployment URL. For one deployment it also says, in plain words, the current stage and time " +
        "so far while deploying, how long it took once live, and, when a build failed, the last lines of the build error " +
        "(build_error.lines) so the cause can be fixed in the code.",
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ deployment_id, path, limit }) => {
      try {
        if (deployment_id) {
          const deployment = normalizeDeployment(await getDeployment(deployment_id));
          const run = await readRun(deployment.run_id);
          deployment.run_status = run.status;
          await probe([deployment]);

          const state = servingState(deployment);
          const failure = latestRunFailure(deployment, run.outcome);
          const buildError = failure && run.status === "failed" ? await readBuildError(deployment.run_id) : null;
          let message = failure
            ? `Deployment ${deployment.id}: ${failure}. Deployment status: ${state}`
            : `Deployment ${deployment.id}: ${state}`;
          // A run that never served may have had an amount set aside; the platform releases it
          // (instantly once the billing release ships, else by its periodic sweep).
          if (failure && deployment.status === "failed") message += ". Any amount set aside for this attempt is released automatically";
          if (buildError) {
            message += `. The build stopped with an error; its last ${buildError.lines.length} line(s) are in build_error.lines. ` +
              "Fix that in the app's code, then deploy again with varity_deploy.";
          } else if (!failure && (run.status === "deploying" || deployment.status === "deploying")) {
            const progress = deployingProgress(run);
            if (progress) message += `. ${progress}`;
          } else if (!failure && run.status === "live" && deployment.status === "live") {
            const took = timeToLive(run);
            if (took) message += `. ${took}`;
          }
          return successResponse(
            {
              deployment,
              ...(buildError ? { build_error: buildError } : {}),
              ...(run.stage ? { run_stage: run.stage } : {}),
              source: "varity_public_api:/api/deployments",
            },
            message
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

        await probe(limited);
        const recentFailure = latestRunFailure(limited[0]!);

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
          `Found ${deployments.length} deployment(s). Most recent: ${limited[0]!.name} (${urlRetired(limited[0]!) ? limited[0]!.status : limited[0]!.url ?? URL_PENDING})` +
            (recentFailure ? `, ${recentFailure}` : "")
        );
      } catch (err) {
        return apiFailure(err, "Run varity_login, then retry varity_deploy_status.");
      }
    }
  );
}
