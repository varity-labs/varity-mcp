import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pushLocalProject, registerCreateRepoTool } from "../dist/tools/create-repo.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function payload(response) {
  return JSON.parse(response.content[0].text);
}

function configureIdentity(projectPath) {
  git(projectPath, ["config", "user.email", "test@varity.so"]);
  git(projectPath, ["config", "user.name", "Varity Test"]);
}

test("create-repo isolates caller repository hooks from the credentialed push", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-safe-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  const hookReceipt = path.join(sandbox, "pre-push-receipt");
  const priorGithubToken = process.env.GITHUB_TOKEN;
  const priorGhToken = process.env.GH_TOKEN;

  try {
    await mkdir(projectPath);
    git(projectPath, ["init"]);
    configureIdentity(projectPath);
    git(sandbox, ["init", "--bare", remotePath]);

    const hookPath = path.join(projectPath, ".git", "hooks", "pre-push");
    await writeFile(
      hookPath,
      `#!/bin/sh\nprintf '%s|%s' "\${GITHUB_TOKEN-unset}" "\${GH_TOKEN-unset}" > "${hookReceipt}"\n`
    );
    await chmod(hookPath, 0o700);
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    git(projectPath, ["add", "--", "app.txt"]);
    git(projectPath, ["commit", "-m", "safe fixture"]);
    const statusBefore = git(projectPath, ["status", "--short"]);

    process.env.GITHUB_TOKEN = "github-secret-canary";
    process.env.GH_TOKEN = "gh-secret-canary";
    pushLocalProject(projectPath, remotePath, "push-token-canary");

    await assert.rejects(readFile(hookReceipt, "utf8"), { code: "ENOENT" });
    assert.equal(git(projectPath, ["status", "--short"]), statusBefore);
    assert.equal(git(projectPath, ["remote"]), "");
    assert.match(git(sandbox, ["--git-dir", remotePath, "show-ref", "--verify", "refs/heads/main"]), /refs\/heads\/main/);
  } finally {
    if (priorGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorGithubToken;
    if (priorGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorGhToken;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo refuses an already-tracked .env file before commit or push", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-secret-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");

  try {
    await mkdir(projectPath);
    git(projectPath, ["init"]);
    configureIdentity(projectPath);
    git(sandbox, ["init", "--bare", remotePath]);

    await mkdir(path.join(projectPath, "dist"));
    await writeFile(path.join(projectPath, "dist", ".env.production"), "SECRET_CANARY=initial\n");
    git(projectPath, ["add", "-f", "--", "dist/.env.production"]);
    git(projectPath, ["commit", "-m", "tracked secret fixture"]);
    await writeFile(path.join(projectPath, "dist", ".env.production"), "SECRET_CANARY=changed\n");
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    const statusBefore = git(projectPath, ["status", "--short"]);

    assert.throws(
      () => pushLocalProject(projectPath, remotePath, "push-token-canary"),
      /Refusing to push credential-bearing paths: dist\/\.env\.production/
    );
    assert.equal(git(projectPath, ["rev-list", "--count", "HEAD"]).trim(), "1");
    assert.equal(git(projectPath, ["status", "--short"]), statusBefore);
    assert.equal(git(projectPath, ["remote"]), "");
    await assert.rejects(access(path.join(projectPath, ".gitignore")), { code: "ENOENT" });
    assert.throws(
      () => git(sandbox, ["--git-dir", remotePath, "show-ref", "--verify", "refs/heads/main"]),
      /Command failed/
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo refuses ignored untracked .env files in nested build output before initializing Git", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-untracked-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  try {
    await mkdir(projectPath);
    await mkdir(path.join(projectPath, "dist"));
    await writeFile(path.join(projectPath, ".gitignore"), ".env*\n");
    await writeFile(path.join(projectPath, "dist", ".env.development"), "SECRET_CANARY=untracked\n");
    git(sandbox, ["init", "--bare", remotePath]);

    assert.throws(
      () => pushLocalProject(projectPath, remotePath, "push-token-canary"),
      /Refusing to push credential-bearing paths: dist\/\.env\.development/
    );
    await assert.rejects(access(path.join(projectPath, ".git")), { code: "ENOENT" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo disables Git template hook injection before initializing a project", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-template-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  const templatePath = path.join(sandbox, "template");
  const hookReceipt = path.join(sandbox, "template-hook-receipt");
  const priorTemplateDirectory = process.env.GIT_TEMPLATE_DIR;

  try {
    await mkdir(projectPath);
    await mkdir(path.join(templatePath, "hooks"), { recursive: true });
    const templateHook = path.join(templatePath, "hooks", "pre-push");
    await writeFile(templateHook, `#!/bin/sh\nprintf ran > "${hookReceipt}"\n`);
    await chmod(templateHook, 0o700);
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    git(sandbox, ["init", "--bare", remotePath]);

    process.env.GIT_TEMPLATE_DIR = templatePath;
    pushLocalProject(projectPath, remotePath, "push-token-canary");

    await assert.rejects(access(hookReceipt), { code: "ENOENT" });
    await assert.rejects(access(path.join(projectPath, ".git")), { code: "ENOENT" });
    await assert.rejects(access(path.join(projectPath, ".git", "hooks", "pre-push")), { code: "ENOENT" });
    assert.match(git(sandbox, ["--git-dir", remotePath, "show-ref", "--verify", "refs/heads/main"]), /refs\/heads\/main/);
  } finally {
    if (priorTemplateDirectory === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = priorTemplateDirectory;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo strips ambient Git config injection before an isolated push", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-config-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  const hooksPath = path.join(sandbox, "ambient-hooks");
  const hookReceipt = path.join(sandbox, "ambient-hook-receipt");
  const priorParameters = process.env.GIT_CONFIG_PARAMETERS;
  const priorCount = process.env.GIT_CONFIG_COUNT;

  try {
    await mkdir(projectPath);
    await mkdir(hooksPath);
    const hookPath = path.join(hooksPath, "pre-push");
    await writeFile(hookPath, `#!/bin/sh\nprintf ran > "${hookReceipt}"\n`);
    await chmod(hookPath, 0o700);
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    git(sandbox, ["init", "--bare", remotePath]);

    process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath=${hooksPath}'`;
    process.env.GIT_CONFIG_COUNT = "0";
    pushLocalProject(projectPath, remotePath, "push-token-canary");

    await assert.rejects(access(hookReceipt), { code: "ENOENT" });
    assert.match(git(sandbox, ["--git-dir", remotePath, "show-ref", "--verify", "refs/heads/main"]), /refs\/heads\/main/);
  } finally {
    if (priorParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = priorParameters;
    if (priorCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = priorCount;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo ignores ambient transport rewrites during the credentialed push", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-transport-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  const globalConfig = path.join(sandbox, "attacker.gitconfig");
  const helperReceipt = path.join(sandbox, "transport-helper-receipt");
  const priorGlobalConfig = process.env.GIT_CONFIG_GLOBAL;

  try {
    await mkdir(projectPath);
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    git(sandbox, ["init", "--bare", remotePath]);
    await writeFile(
      globalConfig,
      `[url "ext::sh -c 'printf ran > ${helperReceipt}'"]\n\tinsteadOf = ${remotePath}\n[protocol "ext"]\n\tallow = always\n`
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    pushLocalProject(projectPath, remotePath, "push-token-canary");

    await assert.rejects(access(helperReceipt), { code: "ENOENT" });
    assert.match(git(sandbox, ["--git-dir", remotePath, "show-ref", "--verify", "refs/heads/main"]), /refs\/heads\/main/);
  } finally {
    if (priorGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = priorGlobalConfig;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo strips ambient index and object-store overrides", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-index-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  const ambientIndex = path.join(sandbox, "ambient-index");
  const ambientObjects = path.join(sandbox, "ambient-objects");
  const priorIndex = process.env.GIT_INDEX_FILE;
  const priorObjects = process.env.GIT_OBJECT_DIRECTORY;
  try {
    await mkdir(projectPath);
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    git(sandbox, ["init", "--bare", remotePath]);
    process.env.GIT_INDEX_FILE = ambientIndex;
    process.env.GIT_OBJECT_DIRECTORY = ambientObjects;

    pushLocalProject(projectPath, remotePath, "push-token-canary");
    delete process.env.GIT_INDEX_FILE;
    delete process.env.GIT_OBJECT_DIRECTORY;

    await assert.rejects(access(ambientIndex), { code: "ENOENT" });
    await assert.rejects(access(ambientObjects), { code: "ENOENT" });
    assert.match(git(sandbox, ["--git-dir", remotePath, "show-ref", "--verify", "refs/heads/main"]), /refs\/heads\/main/);
  } finally {
    if (priorIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = priorIndex;
    if (priorObjects === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
    else process.env.GIT_OBJECT_DIRECTORY = priorObjects;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo strips an ambient Git executable path before credentialed push", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-exec-"));
  const projectPath = path.join(sandbox, "project");
  const maliciousExecPath = path.join(sandbox, "git-exec");
  const helperReceipt = path.join(sandbox, "exec-helper-receipt");
  const priorExecPath = process.env.GIT_EXEC_PATH;
  try {
    await mkdir(projectPath);
    await mkdir(maliciousExecPath);
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    const helperPath = path.join(maliciousExecPath, "git-remote-receipt");
    await writeFile(helperPath, `#!/bin/sh\nprintf '%s' "\${GIT_CONFIG_PARAMETERS-unset}" > "${helperReceipt}"\nexit 1\n`);
    await chmod(helperPath, 0o700);
    process.env.GIT_EXEC_PATH = maliciousExecPath;

    assert.throws(
      () => pushLocalProject(projectPath, "receipt::target", "push-token-canary"),
      /Command failed/
    );
    await assert.rejects(access(helperReceipt), { code: "ENOENT" });
  } finally {
    if (priorExecPath === undefined) delete process.env.GIT_EXEC_PATH;
    else process.env.GIT_EXEC_PATH = priorExecPath;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo refuses common credential-file classes before any push", async () => {
  const canaries = [
    [".npmrc", "//registry.npmjs.org/:_authToken=canary\n"],
    [".git-credentials", "https://token@example.invalid\n"],
    [".docker/config.json", '{"auths":{"example.invalid":{"auth":"canary"}}}\n'],
    [".config/gh/hosts.yml", "github.com:\n  oauth_token: canary\n"],
    ["config/service-account.json", '{"private_key":"canary"}\n'],
    ["tls/private.pem", "PRIVATE KEY CANARY\n"],
  ];

  for (const [relativePath, contents] of canaries) {
    const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-credential-"));
    const projectPath = path.join(sandbox, "project");
    const remotePath = path.join(sandbox, "remote.git");
    try {
      await mkdir(path.dirname(path.join(projectPath, relativePath)), { recursive: true });
      await writeFile(path.join(projectPath, relativePath), contents);
      await writeFile(path.join(projectPath, "app.txt"), "safe\n");
      git(sandbox, ["init", "--bare", remotePath]);

      assert.throws(
        () => pushLocalProject(projectPath, remotePath, "push-token-canary"),
        new RegExp(`Refusing to push credential-bearing paths: ${relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
      await assert.rejects(access(path.join(projectPath, ".git")), { code: "ENOENT" });
      assert.throws(
        () => git(sandbox, ["--git-dir", remotePath, "show-ref", "--verify", "refs/heads/main"]),
        /Command failed/
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
});

test("create-repo pushes a reviewed snapshot without caller history", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-history-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  try {
    await mkdir(projectPath);
    git(projectPath, ["init"]);
    configureIdentity(projectPath);
    await writeFile(path.join(projectPath, ".env.deleted"), "SECRET_CANARY=historical\n");
    git(projectPath, ["add", "--", ".env.deleted"]);
    git(projectPath, ["commit", "-m", "historical secret fixture"]);
    await rm(path.join(projectPath, ".env.deleted"));
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    git(projectPath, ["add", "--", ".env.deleted", "app.txt"]);
    git(projectPath, ["commit", "-m", "remove historical secret"]);
    git(sandbox, ["init", "--bare", remotePath]);

    pushLocalProject(projectPath, remotePath, "push-token-canary");

    assert.equal(git(sandbox, ["--git-dir", remotePath, "rev-list", "--count", "main"]).trim(), "1");
    assert.doesNotMatch(git(sandbox, ["--git-dir", remotePath, "rev-list", "--objects", "--all"]), /\.env\.deleted/);
    assert.equal(git(projectPath, ["rev-list", "--count", "HEAD"]).trim(), "2");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo snapshots reviewed dirty worktree content without mutating the caller", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-dirty-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  try {
    await mkdir(projectPath);
    git(projectPath, ["init"]);
    configureIdentity(projectPath);
    await writeFile(path.join(projectPath, "app.txt"), "original\n");
    git(projectPath, ["add", "--", "app.txt"]);
    git(projectPath, ["commit", "-m", "base"]);
    await writeFile(path.join(projectPath, "app.txt"), "reviewed edit\n");
    await writeFile(path.join(projectPath, "new.txt"), "reviewed new file\n");
    const statusBefore = git(projectPath, ["status", "--short"]);
    git(sandbox, ["init", "--bare", remotePath]);

    pushLocalProject(projectPath, remotePath, "push-token-canary");

    assert.equal(git(projectPath, ["status", "--short"]), statusBefore);
    assert.equal(git(sandbox, ["--git-dir", remotePath, "show", "main:app.txt"]), "reviewed edit\n");
    assert.equal(git(sandbox, ["--git-dir", remotePath, "show", "main:new.txt"]), "reviewed new file\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo never reuses an existing same-name repository", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-new-"));
  const projectPath = path.join(sandbox, "project");
  const remotePath = path.join(sandbox, "remote.git");
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.GITHUB_TOKEN;
  let handler;
  const requests = [];

  try {
    await mkdir(projectPath);
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    git(sandbox, ["init", "--bare", remotePath]);
    registerCreateRepoTool({
      registerTool(_name, _definition, callback) {
        handler = callback;
      },
    });
    process.env.GITHUB_TOKEN = "push-token-canary";
    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      requests.push({ url, method: options.method, body });
      if (requests.length === 1) {
        return {
          ok: false,
          status: 422,
          statusText: "Unprocessable Entity",
          json: async () => ({
            message: "Validation Failed",
            errors: [{ resource: "Repository", field: "name", code: "already_exists" }],
          }),
        };
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({
          full_name: "owner/project-2",
          html_url: "https://github.com/owner/project-2",
          clone_url: remotePath,
          ssh_url: "git@example.invalid:owner/project-2.git",
          private: true,
        }),
      };
    };

    const result = await handler({ name: "project", path: projectPath, visibility: "private" });
    assert.equal(payload(result).success, true);
    assert.deepEqual(requests.map((request) => request.method), ["POST", "POST"]);
    assert.deepEqual(requests.map((request) => request.body.name), ["project", "project-2"]);
    assert.deepEqual(requests.map((request) => request.body.private), [true, true]);
    assert.equal(payload(result).data.repository.name, "owner/project-2");
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorToken;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("create-repo completes local safety preflight before GitHub creation", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-order-"));
  const projectPath = path.join(sandbox, "project");
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.GITHUB_TOKEN;
  let handler;
  let requestCount = 0;
  try {
    await mkdir(projectPath);
    await writeFile(path.join(projectPath, ".env.production"), "SECRET_CANARY=refuse\n");
    registerCreateRepoTool({
      registerTool(_name, _definition, callback) {
        handler = callback;
      },
    });
    process.env.GITHUB_TOKEN = "push-token-canary";
    globalThis.fetch = async () => {
      requestCount += 1;
      throw new Error("must not create a remote before preflight");
    };

    const result = payload(await handler({ name: "project", path: projectPath, visibility: "private" }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, "LOCAL_PROJECT_REFUSED");
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorToken;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("failed push leaves an existing clean repository unchanged", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-create-repo-rollback-"));
  const projectPath = path.join(sandbox, "project");
  try {
    await mkdir(projectPath);
    git(projectPath, ["init"]);
    configureIdentity(projectPath);
    await writeFile(path.join(projectPath, "app.txt"), "safe\n");
    git(projectPath, ["add", "--", "app.txt"]);
    git(projectPath, ["commit", "-m", "safe fixture"]);
    git(projectPath, ["remote", "add", "origin", "https://example.invalid/original.git"]);
    const before = {
      head: git(projectPath, ["rev-parse", "HEAD"]),
      status: git(projectPath, ["status", "--short"]),
      remotes: git(projectPath, ["remote", "-v"]),
    };

    assert.throws(
      () => pushLocalProject(projectPath, path.join(sandbox, "missing.git"), "push-token-canary"),
      /Command failed/
    );
    assert.deepEqual(
      {
        head: git(projectPath, ["rev-parse", "HEAD"]),
        status: git(projectPath, ["status", "--short"]),
        remotes: git(projectPath, ["remote", "-v"]),
      },
      before
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
