#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];

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

if (failures.length > 0) {
  console.error("Architecture governance check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Architecture governance check passed.");
