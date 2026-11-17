/**
 * Infrastructure endpoints (all LIVE). This module reads no file, process or
 * credential, so the remote toolset may import it (`check:architecture`).
 */
export const INFRASTRUCTURE = {
  GATEWAY: process.env["VARITY_GATEWAY_URL"] ?? "https://varity.app",
  DOCS: "https://docs.varity.so",
  DEVELOPER_PORTAL: "https://developer.store.varity.so",
  /** Where a user lists and manages deployments. `varity.app/dashboard` is a 404 (evidence p2-cli-mcp D7). */
  DASHBOARD: "https://developer.store.varity.so/dashboard",
} as const;
