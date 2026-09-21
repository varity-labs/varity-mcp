import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("..", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("retired hosted transport and container release files stay absent", async () => {
  const retired = [
    ".dockerignore",
    "Dockerfile",
    ".github/workflows/release-container.yml",
    "scripts/hosted-release-function-gate.mjs",
    "scripts/release-alias-gate.mjs",
    "scripts/release-auth-fixture.mjs",
    "scripts/validate-release-evidence.mjs",
    "src/auth/http-bearer.ts",
    "src/auth/provider.ts",
    "test/http-auth.mjs",
    "test/container-release.mjs",
  ];
  for (const path of retired) {
    await assert.rejects(access(new URL(path, root)), { code: "ENOENT" }, path);
  }

  const [entrypoint, server, packageJson, workflow] = await Promise.all([
    source("src/index.ts"),
    source("src/server.ts"),
    source("package.json"),
    source(".github/workflows/ci.yml"),
  ]);
  for (const text of [entrypoint, server, packageJson, workflow]) {
    assert.doesNotMatch(text, /StreamableHTTP|startHttp|start:http|gate:hosted|runtime container/i);
  }
});

test("compatibility resource routes mutable deployment facts to live owners", async () => {
  await assert.rejects(access(new URL("src/resources/deploy.ts", root)), { code: "ENOENT" });
  const resource = await source("src/resources/index.ts");
  assert.match(resource, /varity:\/\/deploy\/reference/);
  assert.match(resource, /varity_search_docs/);
  assert.match(resource, /varity_cost_calculator/);
  assert.doesNotMatch(resource, /\$\d|free quota|edge locations|99\.\d%/i);
});

test("local repository helper keeps credentials and history fail closed", async () => {
  const createRepo = await source("src/tools/create-repo.ts");
  assert.doesNotMatch(createRepo, /github_token/);
  assert.doesNotMatch(createRepo, /git["'], \["add", "-A"/);
  assert.doesNotMatch(createRepo, /"--force"/);
  assert.doesNotMatch(createRepo, /"--no-verify"/);
  assert.doesNotMatch(createRepo, /https:\/\/\$\{token\}@/);
  assert.match(createRepo, /name === "GITHUB_TOKEN"[\s\S]*name === "GH_TOKEN"/);
  assert.match(createRepo, /GIT_CONFIG_PARAMETERS/);
  assert.doesNotMatch(createRepo, /GIT_CONFIG_COUNT:|GIT_CONFIG_KEY_0:|GIT_CONFIG_VALUE_0:/);
  assert.match(createRepo, /"ls-files", "-z"/);
  assert.match(createRepo, /"push", cloneUrl, "HEAD:main"/);
  assert.match(createRepo, /mkdtempSync/);
});

test("thin adapters do not restore stale prerequisites or orchestration", async () => {
  const [doctor, install, migrate, prompt, cost, docs, deploy, templates, login, server] = await Promise.all([
    source("src/tools/doctor.ts"),
    source("src/tools/install-deps.ts"),
    source("src/tools/migrate.ts"),
    source("src/prompts/index.ts"),
    source("src/tools/cost-calculator.ts"),
    source("src/tools/search-docs.ts"),
    source("src/tools/deploy.ts"),
    source("src/tools/agent.ts"),
    source("src/tools/login.ts"),
    source("src/server.ts"),
  ]);
  assert.doesNotMatch(doctor, /Not required for MCP tools/);
  assert.doesNotMatch(doctor, /builds run remotely|~3 GB|Python 3\.1[01]/);
  assert.doesNotMatch(install, /Node\.js v18\+/);
  assert.doesNotMatch(migrate, /"--mode"|"--hosting"|npm", \["run", "build"/);
  assert.match(migrate, /MIGRATION_SOURCE_CUSTODY_REQUIRED/);
  assert.doesNotMatch(migrate, /execVaritykit\(\s*"app"/);
  assert.doesNotMatch(prompt, /Call varity_build/);
  assert.doesNotMatch(cost, /PROFILE_KEYS|has_database|has_db|currency:\s*"USD"|billing_model:\s*"fixed/);
  assert.match(docs, /DOC_CACHE_TTL_MS/);
  assert.doesNotMatch(docs, /docs are always current/);
  assert.doesNotMatch(deploy, /image_credentials|--image-password/);
  assert.doesNotMatch(templates, /args\.push\("--env"|env:\s*z\.record/);
  assert.doesNotMatch(login, /deploy_key:\s*z|--key/);
  assert.match(server, /registerSetEnvTool/);
  const setEnv = await source("src/tools/set-env.ts");
  assert.match(setEnv, /SECURE_ENV_CONFIGURATION_REQUIRED/);
  assert.doesNotMatch(setEnv, /z\.record|execVaritykit|KEY=VALUE/);
});
