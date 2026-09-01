#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const INSPECT_TIMEOUT_MS = 30_000;
const CONFIRMED_ABSENT = /(?:manifest unknown|no such manifest|\bnot found\b)/i;
const INDETERMINATE = /(?:unauthorized|authentication required|denied|forbidden|too many requests|rate limit|timed? ?out|timeout|i\/o timeout|context deadline exceeded|temporary failure|unavailable|internal server error|connection refused|connection reset|network is unreachable|bad gateway|gateway timeout|tls handshake|unexpected end|unexpected eof|malformed|invalid character)/i;

export function classifyAliasInspection({ status, stdout = "", stderr = "", error }) {
  if (error || !Number.isInteger(status)) return "indeterminate";
  if (status === 0) return "present";

  const diagnostic = `${stdout}\n${stderr}`.trim();
  if (!diagnostic || INDETERMINATE.test(diagnostic)) return "indeterminate";
  return CONFIRMED_ABSENT.test(diagnostic) ? "absent" : "indeterminate";
}

export function inspectAlias(reference) {
  return spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", reference],
    {
      encoding: "utf8",
      timeout: INSPECT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
}

export function assertAliasesAbsent(references, { inspect = inspectAlias } = {}) {
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error("at least one immutable alias is required");
  }

  for (const reference of references) {
    if (typeof reference !== "string" || !reference.includes(":")) {
      throw new Error("immutable alias reference is malformed");
    }
    const classification = classifyAliasInspection(inspect(reference));
    if (classification === "present") {
      throw new Error(`immutable release alias already exists: ${reference}`);
    }
    if (classification !== "absent") {
      throw new Error(`immutable release alias absence could not be confirmed: ${reference}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [operation, ...references] = process.argv.slice(2);
  if (operation !== "assert-absent") {
    console.error("release-alias-gate: expected assert-absent <reference> [...]");
    process.exit(2);
  }
  try {
    assertAliasesAbsent(references);
    console.log(`release-alias-gate: confirmed ${references.length} immutable alias(es) absent`);
  } catch (error) {
    console.error(`release-alias-gate: ${error instanceof Error ? error.message : "unexpected failure"}`);
    process.exit(1);
  }
}
