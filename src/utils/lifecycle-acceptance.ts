import { lifecycleTracking } from "./cli-bridge.js";

/** Project a successful CLI handoff without claiming an unproven terminal outcome. */
export function lifecycleAcceptance(stdout: string, trackedStatus: string) {
  const tracking = lifecycleTracking(stdout);
  return {
    status: tracking.runId ? trackedStatus : "outcome_unconfirmed",
    run_id: tracking.runId,
    status_command: tracking.statusCommand,
  };
}
