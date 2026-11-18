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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const SCRIPT = new URL("../scripts/prepublish-guard.cjs", import.meta.url);
const RECEIPT_SCRIPT = new URL("../scripts/r1-receipt.cjs", import.meta.url);
const RECEIPT = {
  gateway_version: "1.14.193",
  flag: { name: "VARITY_HOSTED_REPOS_DEPLOY_KEYS_ENABLED", value: true },
  observed_at: "2026-11-20T10:00:00Z",
  result: "passed",
};

function guard({ promise, receipt }) {
  const root = mkdtempSync(join(tmpdir(), "prepublish-guard-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "dist", "tools"), { recursive: true });
    copyFileSync(SCRIPT, join(root, "scripts", "prepublish-guard.cjs"));
    copyFileSync(RECEIPT_SCRIPT, join(root, "scripts", "r1-receipt.cjs"));
    writeFileSync(join(root, "dist", "tools", "deploy-copy.js"),
      promise ? 'export const RULE = "a folder is saved as a private copy Varity keeps";\n' : 'export const RULE = "a folder is deployed";\n');
    if (receipt !== undefined) {
      mkdirSync(join(root, "acceptance"));
      writeFileSync(join(root, "acceptance", "r1-live.json"), typeof receipt === "string" ? receipt : JSON.stringify(receipt));
    }
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
    mkdirSync(join(root, "acceptance"));
    writeFileSync(join(root, "acceptance", "r1-live.json"), JSON.stringify(RECEIPT));
    assert.equal(require("../scripts/r1-receipt.cjs").receiptProblem(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SPA-3: a committed receipt is valid, and ARCHITECTURE.md records the receipt path in ## Verification", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (existsSync(join(root, "acceptance", "r1-live.json"))) {
    assert.equal(require("../scripts/r1-receipt.cjs").receiptProblem(root), null);
  }
  const verification = readFileSync(new URL("../ARCHITECTURE.md", import.meta.url), "utf8").split("## Verification")[1] ?? "";
  assert.match(verification, /acceptance\/r1-live\.json/);
  assert.match(verification, /prepublish-guard\.cjs/);
});
