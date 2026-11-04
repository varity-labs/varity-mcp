import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import { assertReleaseSourceCustody, checkReleaseSourceCustody } from "../scripts/check-release-custody.cjs";

const repositoryRoot = new URL("..", import.meta.url);

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

test("manual publication binds the reviewed main source and a closed request identity before work", () => {
  const workflow = readFileSync(new URL(".github/workflows/publish-npm.yml", repositoryRoot), "utf8");
  const step = workflow.split(/(?=^      - )/m).find(value => value.includes("name: Validate governed publication request"));
  assert.ok(step, "manual publisher must bind its governed source and request");
  assert.match(step, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(step, /EXPECTED_SOURCE: \$\{\{ inputs\.expected_source \}\}/);
  assert.match(step, /REQUEST_ID: \$\{\{ inputs\.request_id \}\}/);
  assert.ok(workflow.indexOf(step) < workflow.indexOf("uses: actions/checkout"));
  const block = step.match(/run: \|\n([\s\S]*)/);
  assert.ok(block);
  const script = block[1].split("\n").map(line => line.slice(10)).join("\n");
  const run = extra => spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    encoding: "utf8", env: { ...process.env, SOURCE_REF: "refs/heads/main", SOURCE_SHA: "a".repeat(40), EXPECTED_SOURCE: "a".repeat(40), REQUEST_ID: "mcp-release-123", ...extra },
  });
  for (const request of ["mcp-release-123", "A:_-.9", "r" + "x".repeat(127)]) {
    assert.equal(run({ REQUEST_ID: request }).status, 0, request);
  }
  for (const extra of [
    { SOURCE_REF: "refs/heads/topic" }, { SOURCE_REF: "refs/tags/mcp-v2.3.25" },
    { EXPECTED_SOURCE: "" }, { EXPECTED_SOURCE: "a".repeat(39) }, { EXPECTED_SOURCE: "A".repeat(40) },
    { SOURCE_SHA: "b".repeat(40) }, // main advanced after the owner selected it
    { REQUEST_ID: "" }, { REQUEST_ID: "bad request" }, { REQUEST_ID: "_bad" },
    { REQUEST_ID: "x".repeat(129) }, { REQUEST_ID: "bad\nrequest" }, { REQUEST_ID: "$(echo unsafe)" },
  ]) {
    const result = run(extra);
    assert.notEqual(result.status, 0, JSON.stringify(extra));
    assert.doesNotMatch(result.stdout + result.stderr, /unsafe|bad request/);
  }
  assert.match(workflow, /^run-name: Publish npm package \(\$\{\{ inputs\.request_id \|\| github\.ref_name \}\}\)$/m);
  for (const name of ["expected_source", "request_id"]) {
    assert.match(workflow, new RegExp(`${name}:\\n(?: {8}[^\\n]+\\n)* {8}required: true`));
  }
});

test("the existing publisher uses native OIDC without surviving token or npm config credentials", () => {
  const workflow = readFileSync(new URL(".github/workflows/publish-npm.yml", repositoryRoot), "utf8");
  const publish = workflow.split(/(?=^      - )/m).find(step => step.includes("name: Publish npm package with trusted publishing"));
  assert.ok(publish, "publisher must use its native OIDC publish step");
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /node-version: 22\.23\.4/);
  assert.match(workflow, /npm install --global npm@12\.2\.1/);
  assert.doesNotMatch(workflow, /registry-url:|secrets\.NPM_TOKEN/);
  assert.ok(workflow.indexOf("node scripts/check-release-custody.cjs") < workflow.indexOf(publish));
  assert.ok(workflow.indexOf("Refuse to overwrite a published version") < workflow.indexOf(publish));
  assert.match(workflow, /SOURCE_REF.*refs\/heads\/main/);
  assert.match(workflow, /mcp-publisher login github-oidc/);
  assert.match(workflow, /cosign verify-blob/);
  const block = publish.match(/run: \|\n([\s\S]*?^          NODE$)/m);
  assert.ok(block, "the workflow's actual publish command must be executable");
  const script = block[1].split("\n").map(line => line.slice(10)).join("\n");
  const directory = mkdtempSync(join(tmpdir(), "mcp-native-publish-"));
  const log = join(directory, "publish.json");
  const fakeNpm = `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
const config=flag=>args.find(x=>x.startsWith(flag+'=')).slice(flag.length+1);
const user=config('--userconfig'),global=config('--globalconfig');
fs.writeFileSync(process.env.NPM_TEST_LOG,JSON.stringify({args,user,global,userContents:fs.readFileSync(user,'utf8'),globalContents:fs.readFileSync(global,'utf8'),keys:Object.keys(process.env),oidc:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}));
process.exit(Number(process.env.NPM_TEST_EXIT||0));
`;
  writeFileSync(join(directory, "npm"), fakeNpm, { mode: 0o700 });
  try {
    const run = (extra = {}) => spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: directory, encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory, NPM_TEST_LOG: log,
        NODE_AUTH_TOKEN: "fixture-token", NPM_TOKEN: "fixture-token", NPM_ID_TOKEN: "fixture-id-token",
        npm_config__auth: "fixture-auth", NPM_CONFIG_USERCONFIG: "/must-not-be-read", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-github-oidc", ...extra },
    });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(actual.args[0], "publish");
    assert.ok(actual.args.includes("--registry=https://registry.npmjs.org"));
    assert.ok(actual.args.includes("--provenance"));
    assert.notEqual(actual.user, actual.global);
    assert.equal(actual.userContents + actual.globalContents, "");
    assert.deepEqual(actual.keys.filter(key => /^(?:npm_config_|NODE_AUTH_TOKEN$|NPM_TOKEN$|NPM_ID_TOKEN$)/i.test(key)), []);
    assert.equal(actual.oidc, "fixture-github-oidc");
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-token|fixture-id-token|fixture-auth/);
    assert.ok(!existsSync(actual.user) && !existsSync(actual.global), "temporary configs are removed");
    const rejected = run({ NPM_TEST_EXIT: "37" });
    assert.equal(rejected.status, 37, "native npm authentication/publication failure must stop the job");
    assert.deepEqual(readdirSync(directory).filter(name => name.startsWith("npm-oidc-")), []);
    rmSync(log);
    const projectConfig = join(directory, ".npmrc");
    writeFileSync(projectConfig, "//registry.npmjs.org/:_authToken=fixture-project-token\n");
    assert.notEqual(run().status, 0);
    assert.equal(existsSync(log), false, "project credentials refuse before npm can run");
    rmSync(projectConfig);
    symlinkSync(join(directory, "absent"), projectConfig);
    assert.notEqual(run().status, 0, "a dangling config symlink is also residue");
    assert.equal(existsSync(log), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
