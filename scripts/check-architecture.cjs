#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];

/** Modules the remote toolset may never reach: host filesystem, processes, OS identity, the CLI. */
const REMOTE_BANNED_BUILTINS = new Set(["fs", "fs/promises", "child_process", "os"]);
const REMOTE_ENTRY = "src/toolsets/remote.ts";
const CLI_BRIDGE = "src/utils/cli-bridge.ts";
// Static value imports and re-exports (`import type` / `export type` carry no code).
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/gm;

/**
 * The remote toolset's static module graph (design d1-hosted §2b): starting at
 * `src/toolsets/remote.ts`, follow relative imports and list every module that
 * imports `node:fs`, `node:child_process`, `node:os` or reaches the CLI bridge.
 * A dynamic `import()` is not followed: the stdio credential fallback in
 * `public-api.ts` loads `config.ts` lazily and a remote server never runs it.
 */
function remoteGraphViolations(base = root) {
  const violations = [];
  const entry = path.join(base, REMOTE_ENTRY);
  if (!fs.existsSync(entry)) return [`missing remote toolset entry: ${REMOTE_ENTRY}`];
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const relative = path.relative(base, file).split(path.sep).join("/");
    for (const match of fs.readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        const builtin = specifier.replace(/^node:/, "");
        if (REMOTE_BANNED_BUILTINS.has(builtin)) violations.push(`${relative} imports ${specifier}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier).replace(/\.js$/, ".ts");
      const targetRelative = path.relative(base, target).split(path.sep).join("/");
      if (targetRelative === CLI_BRIDGE) {
        violations.push(`${relative} reaches ${CLI_BRIDGE}`);
        continue;
      }
      if (fs.existsSync(target)) queue.push(target);
      else violations.push(`${relative} imports a missing module: ${specifier}`);
    }
  }
  return violations;
}

module.exports = { remoteGraphViolations };
if (require.main !== module) return;

for (const violation of remoteGraphViolations()) {
  fail(`remote toolset graph: ${violation}`);
}

function fail(message) {
  failures.push(message);
}

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`missing required architecture file: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(absolutePath, "utf8");
}

const claude = read("CLAUDE.md");
const architecture = read("ARCHITECTURE.md");
const template = read(".github/PULL_REQUEST_TEMPLATE.md");

for (const heading of [
  "## Ownership",
  "## Runtime modules and interfaces",
  "## Transport, auth, and trust",
  "## State and data",
  "## Failure semantics",
  "## Verification",
]) {
  if (!architecture.includes(heading)) {
    fail(`ARCHITECTURE.md is missing required heading: ${heading}`);
  }
}

if (!claude.includes("[ARCHITECTURE.md](ARCHITECTURE.md)")) {
  fail("CLAUDE.md must link to ARCHITECTURE.md");
}
if (!template.includes("Architecture impact:")) {
  fail("pull request template must include the architecture-impact declaration");
}

for (const relativePath of ["CLAUDE.md", "ARCHITECTURE.md"]) {
  const content = read(relativePath);
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(root, path.dirname(relativePath), target);
    if (!fs.existsSync(resolved)) {
      fail(`${relativePath} contains a broken local link: ${match[1]}`);
    }
  }
}

if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    fail("pull_request event payload is unavailable");
  } else {
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    const body = event.pull_request?.body ?? "";
    const actor = event.pull_request?.user?.login;
    // Dependabot owns its generated PR body; all other actors must provide the
    // repository's architecture declaration and supporting fields.
    if (actor !== "dependabot[bot]") {
      if (!/^Architecture impact:\s*(none|updated)\s*$/im.test(body)) {
        fail("pull request body must declare `Architecture impact: none` or `Architecture impact: updated`");
      }
      for (const field of [
        "Reason:",
        "Affected runtime services/modules:",
        "Interfaces/data/security/topology changed:",
        "Architecture/ADR files:",
      ]) {
        if (!body.includes(field)) fail(`pull request body is missing architecture field: ${field}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Architecture governance check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Architecture governance check passed.");
