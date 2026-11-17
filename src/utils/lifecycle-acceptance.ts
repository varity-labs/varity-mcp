import { getRun, type PublicRunAcceptance } from "./public-api.js";

/**
 * The owner's view of one accepted lifecycle operation (deploy, redeploy,
 * delete, template deploy).
 *
 * `public_status` is the gateway's own run vocabulary
 * (`deploying | live | failed | deleting | deleted`) read from
 * `GET /api/deployments/runs/:id`; the MCP invents no status words.
 * WHY: the MCP used to project CLI stdout onto its own strings
 * ("deploying", "outcome_unconfirmed"), a fourth status vocabulary
 * (evidence p2-cli-mcp §5.5). `null` means unobserved — no run was returned,
 * or its view could not be read — never success.
 */
export interface LifecycleAcceptance {
  run_id: string | null;
  public_status: string | null;
  outcome: unknown;
}

export async function lifecycleAcceptance(
  accepted: PublicRunAcceptance
): Promise<LifecycleAcceptance> {
  const runId = typeof accepted.run_id === "string" && accepted.run_id ? accepted.run_id : null;
  if (!runId) return { run_id: null, public_status: null, outcome: null };
  try {
    const run = await getRun(runId);
    return {
      run_id: runId,
      public_status: typeof run.public_status === "string" ? run.public_status : null,
      outcome: run.outcome ?? null,
    };
  } catch {
    return { run_id: runId, public_status: null, outcome: null };
  }
}

/**
 * The one summary of an accepted create (deploy and template deploy): the
 * deployment id the agent tracks, the run and its observed status. Without a
 * run nothing is proven.
 */
export function acceptanceSummary(subject: string, id: unknown, acceptance: LifecycleAcceptance): string {
  if (!acceptance.run_id) {
    return `${subject} returned no run. A live deployment is not yet proven; inspect varity_deploy_status before reporting completion.`;
  }
  return `${subject} accepted (id ${id ?? "unassigned"}, run ${acceptance.run_id}, status ${acceptance.public_status ?? "unobserved"}). ` +
    "Track its terminal outcome with varity_deploy_status using this id; status returns the same id.";
}
