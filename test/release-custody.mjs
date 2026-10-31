import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import { assertReleaseSourceCustody, checkReleaseSourceCustody } from "../scripts/check-release-custody.cjs";

// Captured from the existing public annotated tag and merged billing fix.
const existingTags = {
  "2.3.23": "6a17fe871eab8aef3af41bdb0d9d850bc44c08e1\trefs/tags/mcp-v2.3.23\n98cc89a3f0220c743ac2348e4f6ecd6489be25d3\trefs/tags/mcp-v2.3.23^{}",
};
const billingSource = "6c86af90b694d74ae5235ebfb2664687f6fb3aea";

test("the candidate manifest does not reuse an existing tag owned by another source", () => {
  assertReleaseSourceCustody(packageMetadata.version, billingSource, existingTags[packageMetadata.version] ?? "");
});

test("absent, lightweight and annotated tags preserve exact source custody", () => {
  const tag = "refs/tags/mcp-v1.0.0";
  assert.equal(assertReleaseSourceCustody("1.0.0", billingSource, "").tagSource, null);
  assert.equal(assertReleaseSourceCustody("1.0.0", billingSource, `${billingSource}\t${tag}`).tagSource, billingSource);
  assert.equal(assertReleaseSourceCustody("1.0.0", billingSource, `${"1".repeat(40)}\t${tag}\n${billingSource}\t${tag}^{}`).tagSource, billingSource);
  assert.throws(() => assertReleaseSourceCustody("1.0.0", billingSource, `${"2".repeat(40)}\t${tag}`), /Release source conflicts/);
});

test("malformed and incomplete tag reads cannot become an absent tag", () => {
  const tag = "refs/tags/mcp-v1.0.0";
  for (const listing of [null, "bad", `${billingSource}\t${tag}^{} external`, `${billingSource}\t${tag}^{}`, `${billingSource}\t${tag}\n${billingSource}\t${tag}`, `${billingSource}\trefs/tags/other`]) {
    assert.throws(() => assertReleaseSourceCustody("1.0.0", billingSource, listing), /malformed|incomplete/);
  }
});

test("native Git lookup refuses a stale tag, tracked changes and an unavailable origin", () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-release-custody-"));
  const git = (...args) => execFileSync("git", args, {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const manifest = (version) => writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
  const commit = () => { git("add", "package.json"); git("-c", "user.name=Custody test", "-c", "user.email=custody@example.test", "commit", "-qm", "source"); };
  try {
    git("init", "-q");
    git("remote", "add", "origin", directory);
    manifest("1.0.0"); commit();
    git("tag", "mcp-v1.0.0");
    assert.equal(checkReleaseSourceCustody(directory).tagSource, git("rev-parse", "HEAD"));
    manifest("1.0.1");
    assert.throws(() => checkReleaseSourceCustody(directory), /tracked changes/);
    commit();
    assert.equal(checkReleaseSourceCustody(directory).tagSource, null);
    manifest("1.0.0"); commit();
    assert.throws(() => checkReleaseSourceCustody(directory), /Release source conflicts/);
    git("remote", "set-url", "origin", join(directory, "absent"));
    assert.throws(() => checkReleaseSourceCustody(directory), /could not be read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
