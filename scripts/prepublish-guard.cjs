#!/usr/bin/env node
// prepublish-guard.cjs — fail `npm publish` if forbidden content reached dist/.
//
// WHY: @varity-labs/mcp is a THIN deploy wrapper. Old full-stack-platform vocab
// and comparative positioning must NEVER ship in a published version (CLAUDE.md
// + POSITIONING.md). This is the hard gate behind the "no old content" rule —
// run from prepublishOnly so a stray phrase blocks the release instead of
// reaching users. Greps the BUILT dist/ (what actually ships), not src/.
"use strict";
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
if (!fs.existsSync(DIST)) {
  console.error("[prepublish-guard] dist/ not found — run `npm run build` first.");
  process.exit(1);
}

// Unambiguous forbidden phrases (comparative pricing + competitor cost framing).
// Whole competitor names are intentionally NOT grepped raw — the React `render:`
// prop and similar would false-positive; we match the violating PHRASES instead.
const FORBIDDEN = [
  /\d+\s*-\s*\d+%\s*cheaper/i,     // "60-96% cheaper"
  /%\s*cheaper/i,                  // "...% cheaper"
  /always cheaper/i,
  /\bundercut/i,
  /\bcheapest\b/i,
  /(dramatically|much|far)\s+cheaper/i,
  /compare\s+costs?\s+vs\b/i,      // "Compare costs vs AWS/Vercel"
  /\bvs\.?\s+(aws|vercel|render|railway)\b/i,
  /cheaper than (traditional )?(cloud|aws|vercel|render|railway)/i,
];

const offenders = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(js|cjs|mjs|d\.ts)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split("\n");
    for (const re of FORBIDDEN) {
      lines.forEach((ln, i) => {
        if (re.test(ln)) {
          offenders.push(`${path.relative(DIST, full)}:${i + 1}  [${re}]  ${ln.trim().slice(0, 120)}`);
        }
      });
    }
  }
}
walk(DIST);

if (offenders.length) {
  console.error("\n[prepublish-guard] ❌ Forbidden positioning content in dist/ — publish BLOCKED:\n");
  for (const o of offenders) console.error("  " + o);
  console.error("\nFix the source (declarative, not comparative — see POSITIONING.md), rebuild, retry.\n");
  process.exit(1);
}
console.log("[prepublish-guard] ✅ dist/ is clean (no forbidden positioning content).");

// R1 release gate (ARCHITECTURE.md ## Verification): the private copy works only while the
// gateway's hosted-repository route serves deploy keys. A package whose built text promises it
// is published only with the live-acceptance receipt committed at acceptance/r1-live.json.
const { FLAG, receiptProblem } = require("./r1-receipt.cjs");

const ROOT = path.join(__dirname, "..");

const PHRASE = /private copy/i;
/** The delete tool's cleanup sentence: it names an existing copy and promises none. */
const CLEANUP = "If Varity saved a private copy of a folder for this app, that copy is deleted too.";

/**
 * The initializer text of `export const <name> = ...;` in a built module, or null. Relies on
 * tsc emitting each top-level constant as `export const X = …;` followed by a newline.
 */
function declaration(file, name) {
  const match = new RegExp(`export const ${name} =([\\s\\S]*?);\\n`).exec(fs.readFileSync(file, "utf8"));
  return match ? match[1] : null;
}

/**
 * The package promises the private copy through what it tells a model or a reader, read
 * statically (no dist code runs in this hook): a non-empty FOLDER_RULE (so a rewording stays
 * gated), stdio SERVER_RULES that say "private copy", or a README that says it outside the
 * delete tool's cleanup sentence. Fail closed: a missing deploy copy module, a FOLDER_RULE
 * export that cannot be found (renamed, moved or unexported), or one that is not a plain string
 * counts as a promise. A version that drops the promise declares `export const FOLDER_RULE = "";`.
 */
function promisesPrivateCopy() {
  const copy = path.join(DIST, "tools", "deploy-copy.js");
  if (!fs.existsSync(copy)) return true;
  const rule = declaration(copy, "FOLDER_RULE");
  if (rule === null || !/^\s*"(?:[^"\\]|\\.)*"\s*$/.test(rule) || rule.trim() !== '""') return true;
  const rules = path.join(DIST, "toolsets", "instructions.js");
  if (fs.existsSync(rules) && PHRASE.test(declaration(rules, "SERVER_RULES") ?? "")) return true;
  const readme = path.join(ROOT, "README.md");
  return fs.existsSync(readme) && PHRASE.test(fs.readFileSync(readme, "utf8").split(CLEANUP).join(""));
}

function main() {
  if (promisesPrivateCopy()) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const problem = receiptProblem(ROOT, pkg);
    if (problem) {
      console.error(`\n[prepublish-guard] ❌ the package promises the private copy, but ${problem} — publish BLOCKED.`);
      console.error(`Publish only after the gateway serves deploy keys in production (${FLAG}=true) and its live acceptance passed;`);
      console.error("then commit that receipt, acceptance/r1-live.json (ARCHITECTURE.md ## Verification).\n");
      process.exit(1);
    }
    console.log("[prepublish-guard] ✅ private-copy promise backed by acceptance/r1-live.json.");
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error(`[prepublish-guard] ❌ ${err?.message ?? err} — publish BLOCKED.`);
  process.exit(1);
}
