// r1-receipt.cjs — the R1 live-acceptance receipt check (ARCHITECTURE.md ## Verification).
// One owner for prepublish-guard.cjs and the tests, so a committed receipt is validated,
// never forbidden.
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FLAG = "VARITY_HOSTED_REPOS_DEPLOY_KEYS_ENABLED";

/** What a redacted transcript never holds: keys, owner ids, emails, bearer and GitHub tokens. */
const UNREDACTED = [
  ["a Varity deploy key (vk_)", /vk_[A-Za-z0-9]/],
  ["an owner id (did:privy:)", /did:privy:/],
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["a bearer token", /Bearer /],
  ["a GitHub token (gh?_)", /gh[pousr]_[A-Za-z0-9]/],
];

/**
 * Why `<root>/acceptance/r1-live.json` does not prove the live acceptance of this package
 * (`pkg` is its package.json), or null when it does. The receipt binds the package version
 * and the redacted transcript under acceptance/ by its sha256.
 */
function receiptProblem(root, pkg) {
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
  if (receipt.package_version !== pkg?.version) return `package_version must be "${pkg?.version}" (package.json version)`;
  return evidenceProblem(root, receipt.evidence);
}

/** The evidence must be a file under acceptance/ whose sha256 matches the receipt. */
function evidenceProblem(root, evidence) {
  if (typeof evidence?.path !== "string" || typeof evidence?.sha256 !== "string") return "evidence {path, sha256} is missing";
  const dir = path.join(root, "acceptance");
  const file = path.resolve(root, evidence.path);
  if (path.relative(dir, file).startsWith("..") || path.isAbsolute(path.relative(dir, file))) {
    return "evidence.path must be a file under acceptance/";
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return `evidence file ${evidence.path} does not exist`;
  const bytes = fs.readFileSync(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== evidence.sha256.toLowerCase()) return `evidence sha256 does not match ${evidence.path}`;
  const leak = UNREDACTED.find(([, pattern]) => pattern.test(bytes.toString("utf8")));
  if (leak) return `evidence ${evidence.path} is not redacted: it holds ${leak[0]} (this repository is public)`;
  return null;
}

module.exports = { FLAG, receiptProblem };
