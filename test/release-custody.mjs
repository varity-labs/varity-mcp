import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the native publisher requires its credential-scoped access guard before publication", () => {
  const workflow = readFileSync(new URL(".github/workflows/publish-npm.yml", repositoryRoot), "utf8");
  const steps = workflow.split(/(?=^      - )/m);
  const access = steps.find((step) => step.includes("run: node scripts/check-publisher-access.cjs"));
  const publish = steps.find((step) => step.includes("run: npm publish --access public --provenance"));
  assert.ok(access, "native publisher must verify the authenticated principal's package write permission");
  assert.match(access, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.doesNotMatch(access, /continue-on-error:\s*true/);
  assert.ok(publish && workflow.indexOf(access) < workflow.indexOf(publish));
  assert.doesNotMatch(publish, /always\(\)|failure\(\)/);
});

test("native npm subprocesses prove identity and only that principal's exact package grant", () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-publisher-access-"));
  const log = join(directory, "argv.jsonl");
  const canary = "synthetic-credential-must-not-escape";
  const fakeNpm = `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.NPM_TEST_ARGV,JSON.stringify(args)+'\\n');
const scenario=process.env.NPM_TEST_SCENARIO;
const canary=process.env.NODE_AUTH_TOKEN;
if(args[0]==='whoami'){
 if(scenario==='identity-error'){console.error(canary);process.exit(1);}
 if(scenario==='identity-malformed'){console.log(canary);process.exit(0);}
 if(scenario==='identity-object'){console.log(JSON.stringify({username:'publisher-user'}));process.exit(0);}
 if(scenario==='identity-option'){console.log(JSON.stringify('--unsafe-option'));process.exit(0);}
 console.log(JSON.stringify('publisher-user'));
}else{
 if(scenario==='access-error'){console.error(canary);process.exit(1);}
 if(scenario==='access-malformed'){console.log(canary);process.exit(0);}
 if(scenario==='access-array'){console.log('[]');process.exit(0);}
 const result={'unrelated-collaborator':'read-write'};
 if(scenario!=='missing')result['publisher-user']=scenario==='read-only'?'read-only':scenario==='access-grant-malformed'?{}:'read-write';
 console.log(JSON.stringify(result));
}
`;
  writeFileSync(join(directory, "npm"), fakeNpm, { mode: 0o700 });
  try {
    for (const scenario of ["allowed", "identity-error", "identity-malformed", "identity-object", "identity-option", "access-error", "access-malformed", "access-array", "access-grant-malformed", "missing", "read-only"]) {
      writeFileSync(log, "");
      const result = spawnSync(process.execPath, [new URL("scripts/check-publisher-access.cjs", repositoryRoot).pathname], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, NODE_AUTH_TOKEN: canary, NPM_TEST_ARGV: log, NPM_TEST_SCENARIO: scenario },
      });
      assert.equal(result.status, scenario === "allowed" ? 0 : 1, scenario);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(canary));
      assert.doesNotMatch(result.stdout + result.stderr, /unrelated-collaborator|publisher-user/);
      const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      assert.deepEqual(calls[0], ["whoami", "--json", "--registry=https://registry.npmjs.org"]);
      assert.equal(calls.length, scenario.startsWith("identity-") ? 1 : 2);
      if (calls.length === 2) {
        assert.deepEqual(calls[1], ["access", "list", "collaborators", "@varity-labs/mcp", "publisher-user", "--json", "--registry=https://registry.npmjs.org"]);
      }
      if (scenario === "allowed") assert.match(result.stdout, /token publish scope, 2FA and publication remain unverified/);
      else assert.match(result.stderr, scenario.startsWith("identity-") ? /npm identity/ : /npm package-access/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
