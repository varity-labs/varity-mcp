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
