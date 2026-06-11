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
process.exit(0);
