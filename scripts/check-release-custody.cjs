#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const COMMIT = /^[0-9a-f]{40}$/;

/** An annotated tag's peeled ref names its source commit, not its tag object. */
function assertReleaseSourceCustody(version, sourceCommit, tagListing) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !COMMIT.test(sourceCommit) || typeof tagListing !== "string") {
    throw new Error("Release source custody is malformed; refusing publication.");
  }
  const tag = `refs/tags/mcp-v${version}`;
  const refs = new Map();
  for (const line of tagListing.split("\n").filter(Boolean)) {
    const [commit, ref, extra] = line.split("\t");
    if (!COMMIT.test(commit) || (ref !== tag && ref !== `${tag}^{}`) || extra !== undefined || refs.has(ref)) {
      throw new Error("Release tag lookup is malformed; refusing publication.");
    }
    refs.set(ref, commit);
  }
  if (refs.has(`${tag}^{}`) && !refs.has(tag)) {
    throw new Error("Release tag lookup is incomplete; refusing publication.");
  }
  const tagSource = refs.get(`${tag}^{}`) ?? refs.get(tag) ?? null;
  if (tagSource !== null && tagSource !== sourceCommit) {
    throw new Error(`Release source conflicts with existing mcp-v${version}; use an unused version without rewriting the tag.`);
  }
  return { version, sourceCommit, tag, tagSource };
}

/** Read custody through Git itself; failed reads never count as an absent tag. */
function checkReleaseSourceCustody(repositoryRoot = join(__dirname, "..")) {
  const { version } = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  function git(args) {
    try {
      return execFileSync("git", args, {
        cwd: repositoryRoot, encoding: "utf8", timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new Error("Release source custody could not be read; refusing publication.");
    }
  }
  if (git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("Release source has tracked changes; refusing publication.");
  }
  const sourceCommit = git(["rev-parse", "HEAD"]);
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Release package version is malformed; refusing publication.");
  }
  const tag = `refs/tags/mcp-v${version}`;
  return assertReleaseSourceCustody(version, sourceCommit, git(["ls-remote", "--tags", "origin", tag, `${tag}^{}`]));
}

module.exports = { assertReleaseSourceCustody, checkReleaseSourceCustody };

if (require.main === module) {
  try {
    const result = checkReleaseSourceCustody();
    console.log(`Release source custody verified for mcp-v${result.version} at ${result.sourceCommit}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
