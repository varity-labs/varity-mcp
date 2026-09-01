#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REQUIRED_FILES = Object.freeze([
  "acceptance.stderr",
  "acceptance.stdout",
  "auth-fixture.stderr",
  "auth-fixture.stdout",
  "container.stderr",
  "container.stdout",
  "gate.receipt.json",
  "gate.stderr",
  "gate.stdout",
  "health.json",
  "release.receipt.json",
]);

function readRegularFile(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile()) throw new Error(`evidence entry is not a regular file: ${relativePath}`);
  return readFileSync(absolutePath, "utf8");
}

function parseJson(root, relativePath) {
  try {
    return JSON.parse(readRegularFile(root, relativePath));
  } catch (error) {
    throw new Error(`invalid ${relativePath}: ${error instanceof Error ? error.message : "parse failure"}`);
  }
}

export function validateReleaseEvidence({ root, bearer, expectedDigest, expectedVersion }) {
  if (!root || !bearer || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest ?? "") || !/^\d+\.\d+\.\d+$/.test(expectedVersion ?? "")) {
    throw new Error("release evidence validation configuration is invalid");
  }

  const entries = readdirSync(root).sort();
  for (const required of REQUIRED_FILES) {
    if (!entries.includes(required)) throw new Error(`required evidence file is missing: ${required}`);
  }
  for (const entry of entries) {
    const content = readRegularFile(root, entry);
    if (content.includes(bearer)) throw new Error(`release evidence exposed its bearer in ${entry}`);
  }

  const health = parseJson(root, "health.json");
  if (health?.status !== "ok" || health?.transport !== "http" || health?.version !== expectedVersion) {
    throw new Error("health evidence does not identify the exact accepted release");
  }

  const gate = parseJson(root, "gate.receipt.json");
  if (
    gate?.version !== expectedVersion ||
    gate?.serverInfoVersion !== expectedVersion ||
    gate?.anonymous !== "rejected" ||
    JSON.stringify(gate?.tools) !== JSON.stringify(["varity_search_docs"]) ||
    gate?.toolsCall?.name !== "varity_search_docs" ||
    gate?.toolsCall?.result !== "bounded-public-docs-pass"
  ) {
    throw new Error("function-gate receipt is incomplete or identifies the wrong release");
  }

  const release = parseJson(root, "release.receipt.json");
  if (release?.acceptedDigest !== expectedDigest || release?.version !== expectedVersion || release?.acceptance !== "PASS") {
    throw new Error("release receipt does not identify the exact accepted digest and version");
  }

  const gateStdout = readRegularFile(root, "gate.stdout");
  for (const receipt of ["exact HTTP release", "exact public-read tool allowlist", "public documentation search returned one bounded result", "hosted-mcp-release-function-gate: passed"]) {
    if (!gateStdout.includes(receipt)) throw new Error(`gate stdout is missing receipt: ${receipt}`);
  }
  const acceptance = readRegularFile(root, "acceptance.stdout");
  if (!acceptance.includes(`ACCEPTANCE PASS digest=${expectedDigest} version=${expectedVersion}`)) {
    throw new Error("acceptance stdout is missing the exact digest/version PASS receipt");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    validateReleaseEvidence({
      root: process.env.RELEASE_EVIDENCE_DIR,
      bearer: process.env.RELEASE_EVIDENCE_BEARER,
      expectedDigest: process.env.RELEASE_EVIDENCE_DIGEST,
      expectedVersion: process.env.RELEASE_EVIDENCE_VERSION,
    });
    console.log("release-evidence: complete, exact, and credential-opaque");
  } catch (error) {
    console.error(`release-evidence: ${error instanceof Error ? error.message : "unexpected failure"}`);
    process.exit(1);
  }
}
