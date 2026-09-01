import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertAliasesAbsent, classifyAliasInspection } from "../scripts/release-alias-gate.mjs";
import { validateReleaseEvidence } from "../scripts/validate-release-evidence.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const version = "2.3.15";
const bearer = "release-bearer-that-must-remain-opaque";

test("immutable alias absence requires an unambiguous missing-manifest diagnostic", () => {
  assert.equal(classifyAliasInspection({ status: 1, stderr: "manifest unknown" }), "absent");
  assert.equal(classifyAliasInspection({ status: 1, stderr: "no such manifest" }), "absent");
  assert.equal(classifyAliasInspection({ status: 1, stderr: "reference not found: missing tag" }), "indeterminate");
  assert.equal(classifyAliasInspection({ status: 0 }), "present");
  for (const outcome of [
    { status: 1, stderr: "unauthorized: authentication required" },
    { status: 1, stderr: "503 Service Unavailable" },
    { status: 1, stderr: "request timed out" },
    { status: 1, stderr: "invalid character in registry response" },
    { status: 1, stderr: "reference not found: missing tag" },
    { status: 1, stderr: 'error getting credentials - err: exec: "docker-credential-pass": executable file not found in $PATH' },
    { status: 1, stderr: "authentication helper not found" },
    { status: 1, stderr: "docker: 'buildx' is not a docker command" },
    { status: 1, stderr: "" },
    { status: null, error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }) },
    { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
  ]) {
    assert.equal(classifyAliasInspection(outcome), "indeterminate");
    assert.throws(
      () => assertAliasesAbsent(["ghcr.io/varity-labs/varity-mcp:2.3.15"], { inspect: () => outcome }),
      /absence could not be confirmed/,
    );
  }
});

test("a promotion-time recheck closes the initial-check TOCTOU window", () => {
  let calls = 0;
  const inspect = () => calls++ === 0
    ? { status: 1, stderr: "manifest unknown" }
    : { status: 0, stdout: "present" };
  const aliases = ["ghcr.io/varity-labs/varity-mcp:2.3.15"];
  assert.doesNotThrow(() => assertAliasesAbsent(aliases, { inspect }));
  assert.throws(() => assertAliasesAbsent(aliases, { inspect }), /already exists/);
});

function makeEvidence(t) {
  const root = mkdtempSync(path.join(tmpdir(), "varity-mcp-release-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "acceptance.stderr": "",
    "acceptance.stdout": `ACCEPTANCE PASS digest=${digest} version=${version} health=exact tools/list=exact tools/call=real\n`,
    "auth-fixture.stderr": "release-auth-fixture: ready\n",
    "auth-fixture.stdout": "",
    "container.stderr": "",
    "container.stdout": "runtime ready\n",
    "gate.receipt.json": JSON.stringify({
      version,
      serverInfoVersion: version,
      anonymous: "rejected",
      tools: ["varity_search_docs"],
      toolsCall: { name: "varity_search_docs", result: "bounded-public-docs-pass" },
    }),
    "gate.stderr": "",
    "gate.stdout": [
      `exact HTTP release ${version} identified`,
      "exact public-read tool allowlist",
      "public documentation search returned one bounded result",
      "hosted-mcp-release-function-gate: passed",
    ].join("\n"),
    "health.json": JSON.stringify({ status: "ok", transport: "http", version }),
    "release.receipt.json": JSON.stringify({ acceptedDigest: digest, version, acceptance: "PASS" }),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
  return root;
}

function validate(root) {
  return validateReleaseEvidence({ root, bearer, expectedDigest: digest, expectedVersion: version });
}

test("self-contained evidence proves exact digest, health, tools/list, real tools/call, and PASS", (t) => {
  const root = makeEvidence(t);
  assert.doesNotThrow(() => validate(root));
});

test("evidence validation fails closed on bearer exposure, malformed receipts, and scan errors", async (t) => {
  await t.test("bearer exposure", () => {
    const root = makeEvidence(t);
    writeFileSync(path.join(root, "container.stderr"), bearer);
    assert.throws(() => validate(root), /exposed its bearer/);
  });
  await t.test("malformed receipt", () => {
    const root = makeEvidence(t);
    writeFileSync(path.join(root, "release.receipt.json"), "not-json");
    assert.throws(() => validate(root), /invalid release\.receipt\.json/);
  });
  await t.test("non-regular diagnostic", () => {
    const root = makeEvidence(t);
    const diagnostic = path.join(root, "container.stdout");
    unlinkSync(diagnostic);
    symlinkSync(path.join(root, "gate.stdout"), diagnostic);
    assert.throws(() => validate(root), /not a regular file/);
  });
});
