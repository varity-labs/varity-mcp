/**
 * SPN-3 (R1 review spec-c1f295a): the private-copy release gate is executable. `npm publish`
 * runs scripts/prepublish-guard.cjs (prepublishOnly); when the built package promises the
 * private copy, it refuses unless the live-acceptance receipt acceptance/r1-live.json exists
 * and names the gateway version, the flag (on), when it was observed and a passed result.
 * Each case runs the real script in a scratch root holding its own dist/ and acceptance/.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const SCRIPT = new URL("../scripts/prepublish-guard.cjs", import.meta.url);
const RECEIPT_SCRIPT = new URL("../scripts/r1-receipt.cjs", import.meta.url);
const EVIDENCE = "R1 live acceptance, redacted transcript\n";
const RECEIPT = {
  gateway_version: "1.14.193",
  flag: { name: "VARITY_HOSTED_REPOS_DEPLOY_KEYS_ENABLED", value: true },
  observed_at: "2026-11-20T10:00:00Z",
  result: "passed",
  package_version: "2.3.30",
  evidence: { path: "acceptance/r1-live-evidence.txt", sha256: createHash("sha256").update(EVIDENCE).digest("hex") },
};
const PROMISE = 'export const RULE = "a folder is saved as a private copy Varity keeps";\n';
const NO_PROMISE = 'export const RULE = "a folder is deployed";\n';

/** A scratch package root: package.json (2.3.30), dist/tools/deploy-copy.js, README, acceptance/. */
function scratch(root, { promise, dist, readme, receipt, evidence = EVIDENCE }) {
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "dist", "tools"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts", "prepublish-guard.cjs"));
  copyFileSync(RECEIPT_SCRIPT, join(root, "scripts", "r1-receipt.cjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "scratch", version: "2.3.30", type: "module" }));
  writeFileSync(join(root, "dist", "tools", "deploy-copy.js"), dist ?? (promise ? PROMISE : NO_PROMISE));
  if (readme !== undefined) writeFileSync(join(root, "README.md"), readme);
  if (receipt !== undefined) {
    mkdirSync(join(root, "acceptance"));
    writeFileSync(join(root, "acceptance", "r1-live.json"), typeof receipt === "string" ? receipt : JSON.stringify(receipt));
    if (evidence !== null) writeFileSync(join(root, "acceptance", "r1-live-evidence.txt"), evidence);
  }
}

function guard(options) {
  const root = mkdtempSync(join(tmpdir(), "prepublish-guard-"));
  try {
    scratch(root, options);
    const run = spawnSync(process.execPath, [join(root, "scripts", "prepublish-guard.cjs")], { encoding: "utf8" });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("SPN-3: a package that promises the private copy is refused without the live-acceptance receipt", () => {
  const { status, output } = guard({ promise: true });
  assert.notEqual(status, 0);
  assert.match(output, /private copy/);
  assert.match(output, /acceptance\/r1-live\.json/);
});

test("SPN-3: an incomplete or failed receipt is refused, naming what is missing", () => {
  for (const [receipt, why] of [
    ["not json", /not valid JSON/],
    [{ ...RECEIPT, result: "failed" }, /result/],
    [{ ...RECEIPT, flag: { name: "VARITY_HOSTED_REPOS_DEPLOY_KEYS_ENABLED", value: false } }, /flag/],
    [{ ...RECEIPT, gateway_version: "" }, /gateway_version/],
    [{ ...RECEIPT, observed_at: "yesterday" }, /observed_at/],
  ]) {
    const { status, output } = guard({ promise: true, receipt });
    assert.notEqual(status, 0, JSON.stringify(receipt));
    assert.match(output, why, output);
  }
});

test("SPN-3: with a passed receipt, or with no private-copy promise, the guard lets the publish through", () => {
  assert.equal(guard({ promise: true, receipt: RECEIPT }).status, 0);
  assert.equal(guard({ promise: false }).status, 0);
});

test("SPA-3: scripts/r1-receipt.cjs accepts a valid receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "r1-receipt-"));
  try {
    scratch(root, { promise: true, receipt: RECEIPT });
    assert.equal(require("../scripts/r1-receipt.cjs").receiptProblem(root, { version: "2.3.30" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SPA-3: a committed receipt is valid, and ARCHITECTURE.md records the receipt path in ## Verification", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (existsSync(join(root, "acceptance", "r1-live.json"))) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(require("../scripts/r1-receipt.cjs").receiptProblem(root, pkg), null);
  }
  const verification = readFileSync(new URL("../ARCHITECTURE.md", import.meta.url), "utf8").split("## Verification")[1] ?? "";
  assert.match(verification, /acceptance\/r1-live\.json/);
  assert.match(verification, /prepublish-guard\.cjs/);
  assert.match(verification, /package_version/);
  assert.match(verification, /sha256/);
});

test("SPA-1: ARCHITECTURE.md ## Verification names the one publish path that runs the gate", async () => {
  const { readFileSync } = await import("node:fs");
  const verification = readFileSync(new URL("../ARCHITECTURE.md", import.meta.url), "utf8").split("## Verification")[1] ?? "";
  assert.ok(verification.includes(
    "Publish with plain `npm publish` from the clean clone at the release commit; never `--ignore-scripts` " +
    "(or `ignore-scripts=true` in any npmrc or env), never a tarball, never `yarn npm publish`: each skips " +
    "`prepublishOnly` and with it this gate."), verification);
});

test("SPA-2: a receipt for another package_version is refused", () => {
  const { status, output } = guard({ promise: true, receipt: { ...RECEIPT, package_version: "2.3.29" } });
  assert.notEqual(status, 0);
  assert.match(output, /package_version/, output);
});

test("SPA-2: a receipt whose evidence file is missing or whose sha256 differs is refused", () => {
  for (const [options, why] of [
    [{ evidence: null }, /evidence/],
    [{ evidence: "a different transcript\n" }, /sha256/],
    [{ receipt: { ...RECEIPT, evidence: { ...RECEIPT.evidence, path: "../outside.txt" } } }, /evidence/],
    [{ receipt: { ...RECEIPT, evidence: undefined } }, /evidence/],
  ]) {
    const { status, output } = guard({ promise: true, receipt: RECEIPT, ...options });
    assert.notEqual(status, 0, JSON.stringify(options));
    assert.match(output, why, output);
  }
});

test("SPA-2: README-only promise is gated", () => {
  const { status, output } = guard({ promise: false, readme: "Varity keeps a private copy of your folder.\n" });
  assert.notEqual(status, 0);
  assert.match(output, /acceptance\/r1-live\.json/, output);
});

test("SPA-2: a dist whose FOLDER_RULE is reworded without the phrase 'private copy' is still gated", () => {
  const { status, output } = guard({ dist: 'export const FOLDER_RULE = "a folder is kept by Varity and built.";\n' });
  assert.notEqual(status, 0);
  assert.match(output, /acceptance\/r1-live\.json/, output);
});
