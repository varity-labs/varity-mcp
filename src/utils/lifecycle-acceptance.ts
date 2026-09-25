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
