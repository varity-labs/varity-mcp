import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  createDeploymentApproval,
  deleteDeployment,
  getDeployment,
  hostedRouteUnavailable,
  listHostedRepositories,
  queueHostedRepositoryDeletion,
  VarityPublicApiError,
  type PublicDeployment,
} from "../utils/public-api.js";
import { lifecycleAcceptance } from "../utils/lifecycle-acceptance.js";
import { INFRASTRUCTURE } from "../utils/endpoints.js";

/**
 * `varity_delete_deployment` → `DELETE /api/deployments/:deployment` through
 * the one public-API client. The gateway resolves an id or an app name,
 * including a failed deploy that never got a route (varity-gateway
 * services/deploy-ops-public.ts `resolveOwnedDeployment`).
 *
 * A deployment built from a private copy this key saved (`varity_deploy` of a
 * folder, a hosted repository listed `created_by: "deploy_key"`) has that
 * copy's durable deletion queued first, in the Portal's order: the gateway's
 * worker removes it once no deployment uses it. Queueing never blocks the
 * app delete.
 *
 * A retry after the app is already gone (its read answers 404, or it reads
 * deleted with no source) finds the copy by app name instead: the gateway
 * names a copy `<16 hex owner prefix>-<slug>` (github-authority.ts
 * HOSTED_REPO_NAME) and `varity_deploy` uses the app name as the slug, so the
 * cleanup never depends on the deployment still resolving.
 */

type SourceCopy = "deletion_queued" | "not_queued" | null;

const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTED_NAME = /^[0-9a-f]{16}-([a-z0-9-]+)$/;

/** Which listed copy belongs to this deployment: by its source URL, or (app already gone) by app name. */
function copyMatcher(before: PublicDeployment | null, locator: string): ((repo: { name: string; full_name: string }) => boolean) | null {
  const url = before?.source?.repository_url;
  const match = typeof url === "string" ? /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url) : null;
  if (match) {
    const fullName = `${match[1]}/${match[2]}`.toLowerCase();
    return (repo) => repo.full_name.toLowerCase() === fullName;
  }
  const gone = before === null || before.status === "deleted";
  if (!gone || DEPLOYMENT_ID.test(locator)) return null;
  const slug = locator.toLowerCase();
  return (repo) => HOSTED_NAME.exec(repo.name)?.[1] === slug;
}

/** Queues the private copy's deletion; null when the deployment has none this key made. */
async function queueSourceCopyDeletion(before: PublicDeployment | null, locator: string): Promise<SourceCopy> {
  const belongs = copyMatcher(before, locator);
  if (!belongs) return null;
  try {
    const listing = await listHostedRepositories();
    const listed = listing.repositories.find(belongs);
    if (!listed) return listing.truncated ? "not_queued" : null;
    if (listed.created_by !== "deploy_key") return null;
    const fullName = listed.full_name.toLowerCase();
    const approvalId = await createDeploymentApproval({
      kind: "delete_hosted_repository",
      target: `repository:${fullName}`,
      fingerprint: `${fullName}:${listed.id}`,
    });
    const job = await queueHostedRepositoryDeletion(listed.name, listed.id, approvalId);
    return job.status === "pending" || job.status === "deleted" ? "deletion_queued" : "not_queued";
  } catch (err) {
    // A gateway without private copies for keys has none to clean up.
    return hostedRouteUnavailable(err) ? null : "not_queued";
  }
}

/** What to tell the user about the copy; `appName` is what a retry must name once the app is gone. */
function sourceCopyNote(sourceCopy: Exclude<SourceCopy, null>, appName: string | null): string {
  if (sourceCopy === "deletion_queued") return "Its private source copy is deleted once the app is gone.";
  return (
    "Varity could not queue the deletion of its private source copy; call varity_delete_deployment again " +
    `${appName ? `with "${appName}"` : "with this app's name"} to retry the source cleanup.`
  );
}

/**
 * Said when the copy was queued but the app delete did not go through: the
 * gateway has no cancel (the Portal's `queuedRepositoryNotice`).
 */
function queuedNotice(already: boolean): string {
  return `Its private source copy is ${already ? "already " : ""}queued for deletion and is removed once no deployment uses it.`;
}

export async function deleteAccepted(
  deployment: string,
  accepted: Awaited<ReturnType<typeof deleteDeployment>>,
  hadUrl = true,
  sourceCopy: SourceCopy = null,
  appName: string | null = deployment
) {
  const acceptance = await lifecycleAcceptance(accepted);
  const deleted = accepted.deleted === true || acceptance.public_status === "deleted";
  // Live: the URL kept serving for up to ~40 s after status deleted (E1 journey 3).
  const cached = hadUrl ? " The URL may serve cached content briefly after deletion." : "";
  const message = deleted
      ? `"${deployment}" is deleted.${cached}`
      : acceptance.run_id
        ? `Delete accepted for "${deployment}" (run ${acceptance.run_id}, status ${acceptance.public_status ?? "unobserved"}). Poll varity_deploy_status with "${deployment}" until status is deleted and billing.state is stopped; billing stop is not proven before then.${cached}`
        : `The delete request for "${deployment}" returned no run. Deletion and billing stop are not proven; check varity_deploy_status before retrying.`;
  return successResponse(
    { deployment, ...acceptance, deleted, ...(sourceCopy ? { source_copy: sourceCopy } : {}) },
    sourceCopy ? `${message} ${sourceCopyNote(sourceCopy, appName)}` : message
  );
}

export function registerDeleteDeploymentTool(server: McpServer): void {
  server.registerTool(
    "varity_delete_deployment",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      title: "Request Deletion of a Deployment",
      description:
        "Request deletion of an existing Varity deployment by id or app name. Returns as soon as the delete is accepted, " +
        "usually with status deleting; it does not wait. Billing stop is proven only when varity_deploy_status shows " +
        "status deleted and billing.state stopped, so poll that tool before telling the developer billing has stopped. " +
        "Use this when a developer says 'stop my <name>', 'shut down my deployment', 'I'm done with <name>', " +
        "'delete <name>', or when they no longer need a running app or agent. " +
        "The durable operation independently reconciles route removal, reserved hardware release, and billing stop. " +
        "If Varity saved a private copy of a folder for this app, that copy is deleted too. " +
        `Use varity_deploy_status or list deployments at ${INFRASTRUCTURE.DASHBOARD} to confirm the deployment first if the developer is unsure.`,
      inputSchema: {
        deployment: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/, "Invalid deployment id or app name")
          .describe(
            "The deployment id or app name (the slug in https://varity.app/<name>/), " +
              "including a deployment that failed before it got a URL. Example: 'worker-bot'."
          ),
      },
    },
    async ({ deployment }) => {
      // Best effort: only an app that ever had a URL can serve cached content after delete.
      let hadUrl = true;
      let before: PublicDeployment | null = null;
      try {
        before = await getDeployment(deployment);
        hadUrl = Boolean(before.url ?? before.public_url);
      } catch {
        // Unknown: keep the cached-content line.
      }
      // A retry by name works once the app is gone; an id does not, so the note names the app.
      const appName = before?.app_name ?? before?.appName ?? (DEPLOYMENT_ID.test(deployment) ? null : deployment);
      // Before the app delete (the Portal's order), so the intent outlives this call.
      const sourceCopy = await queueSourceCopyDeletion(before, deployment);
      const withCopy = (message: string) => (sourceCopy ? `${message} ${sourceCopy === "deletion_queued" ? queuedNotice(true) : sourceCopyNote(sourceCopy, appName)}` : message);
      try {
        return await deleteAccepted(deployment, await deleteDeployment(deployment), hadUrl, sourceCopy, appName);
      } catch (err) {
        if (err instanceof VarityPublicApiError && err.status === 404) {
          if (sourceCopy === "deletion_queued") {
            return successResponse(
              { deployment, found: false, source_copy: sourceCopy },
              `No deployment "${deployment}" is left to delete. ${queuedNotice(false)}`
            );
          }
          return errorResponse(
            "DEPLOYMENT_NOT_FOUND",
            withCopy(`No deployment found for "${deployment}".`),
            `Check the id or name with varity_deploy_status or at ${INFRASTRUCTURE.DASHBOARD}.`
          );
        }
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, withCopy(err.message), err.action ?? `Check ${INFRASTRUCTURE.DASHBOARD}.`);
        }
        return errorResponse("DELETE_FAILED", withCopy(`Could not delete "${deployment}".`), "Retry the request.");
      }
    }
  );
}
