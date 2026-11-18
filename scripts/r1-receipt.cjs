// r1-receipt.cjs — the R1 live-acceptance receipt check (ARCHITECTURE.md ## Verification).
// One owner for prepublish-guard.cjs and the tests, so a committed receipt is validated,
// never forbidden.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const FLAG = "VARITY_HOSTED_REPOS_DEPLOY_KEYS_ENABLED";

/** Why `<root>/acceptance/r1-live.json` does not prove the live acceptance, or null when it does. */
function receiptProblem(root) {
  const file = path.join(root, "acceptance", "r1-live.json");
  if (!fs.existsSync(file)) return "acceptance/r1-live.json does not exist";
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return "acceptance/r1-live.json is not valid JSON";
  }
  if (typeof receipt.gateway_version !== "string" || !receipt.gateway_version.trim()) return "gateway_version is missing";
  if (receipt.flag?.name !== FLAG || receipt.flag?.value !== true) return `flag must be {"name":"${FLAG}","value":true}`;
  if (typeof receipt.observed_at !== "string" || Number.isNaN(Date.parse(receipt.observed_at))) return "observed_at is not an ISO 8601 time";
  if (receipt.result !== "passed") return 'result is not "passed"';
  return null;
}

module.exports = { FLAG, receiptProblem };
