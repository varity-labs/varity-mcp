import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  createDeploymentApproval,
  deleteDeployment,
  getDeployment,
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
 */

type SourceCopy = "deletion_queued" | "not_queued" | null;

/** Queues the private copy's deletion; null when the deployment has none this key made. */
async function queueSourceCopyDeletion(before: PublicDeployment | null): Promise<SourceCopy> {
  const url = before?.source?.repository_url;
  const match = typeof url === "string" ? /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url) : null;
  if (!match) return null;
  const fullName = `${match[1]}/${match[2]}`.toLowerCase();
  try {
    const listing = await listHostedRepositories();
    const listed = listing.repositories.find((repo) => repo.full_name.toLowerCase() === fullName);
    if (!listed) return listing.truncated ? "not_queued" : null;
    if (listed.created_by !== "deploy_key") return null;
    const approvalId = await createDeploymentApproval({
      kind: "delete_hosted_repository",
      target: `repository:${fullName}`,
      fingerprint: `${fullName}:${listed.id}`,
    });
    const job = await queueHostedRepositoryDeletion(listed.name, listed.id, approvalId);
    return job.status === "pending" || job.status === "deleted" ? "deletion_queued" : "not_queued";
  } catch (err) {
    // A gateway without private copies for keys (404, or the single 403) has none to clean up.
    if (err instanceof VarityPublicApiError && (err.status === 404 || (err.status === 403 && err.code === "repo_authority_required"))) {
      return null;
    }
    return "not_queued";
  }
}

const SOURCE_COPY_NOTE: Record<Exclude<SourceCopy, null>, string> = {
  deletion_queued: "Its private source copy is deleted once the app is gone.",
  not_queued: "Varity could not queue the deletion of its private source copy; call varity_delete_deployment again to retry the source cleanup.",
};
export async function deleteAccepted(
  deployment: string,
  accepted: Awaited<ReturnType<typeof deleteDeployment>>,
  hadUrl = true,
  sourceCopy: SourceCopy = null
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
    sourceCopy ? `${message} ${SOURCE_COPY_NOTE[sourceCopy]}` : message
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
      try {
        // Best effort: only an app that ever had a URL can serve cached content after delete.
        let hadUrl = true;
        let before: PublicDeployment | null = null;
        try {
          before = await getDeployment(deployment);
          hadUrl = Boolean(before.url ?? before.public_url);
        } catch {
          // Unknown: keep the cached-content line.
        }
        // Before the app delete (the Portal's order), so the intent outlives this call.
        const sourceCopy = await queueSourceCopyDeletion(before);
        return await deleteAccepted(deployment, await deleteDeployment(deployment), hadUrl, sourceCopy);
      } catch (err) {
        if (err instanceof VarityPublicApiError && err.status === 404) {
          return errorResponse(
            "DEPLOYMENT_NOT_FOUND",
            `No deployment found for "${deployment}".`,
            `Check the id or name with varity_deploy_status or at ${INFRASTRUCTURE.DASHBOARD}.`
          );
        }
        if (err instanceof VarityPublicApiError) {
          return errorResponse(err.code, err.message, err.action ?? `Check ${INFRASTRUCTURE.DASHBOARD}.`);
        }
        return errorResponse("DELETE_FAILED", `Could not delete "${deployment}".`, "Retry the request.");
      }
    }
  );
}
