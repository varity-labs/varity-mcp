import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pushLocalProject } from "../dist/tools/create-repo.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function configureIdentity(projectPath) {
  git(projectPath, ["config", "user.email", "test@varity.so"]);
  git(projectPath, ["config", "user.name", "Varity Test"]);
}

test("create-repo refuses repository hooks before a credentialed push", async () => {
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
    const statusBefore = git(projectPath, ["status", "--short"]);

    process.env.GITHUB_TOKEN = "github-secret-canary";
    process.env.GH_TOKEN = "gh-secret-canary";
    assert.throws(
      () => pushLocalProject(projectPath, remotePath, "push-token-canary"),
      /Refusing credentialed push while Git hooks are configured: active hooks: pre-push/
    );

    await assert.rejects(readFile(hookReceipt, "utf8"), { code: "ENOENT" });
    assert.equal(git(projectPath, ["status", "--short"]), statusBefore);
    assert.equal(git(projectPath, ["remote"]), "");
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
      /Refusing to commit or push secret-bearing \.env\* paths: dist\/\.env\.production/
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

test("create-repo refuses ignored untracked .env files in skipped build output before initializing Git", async () => {
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
      /Refusing to commit or push secret-bearing \.env\* paths: dist\/\.env\.development/
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
    await assert.rejects(access(path.join(projectPath, ".git", "hooks", "pre-push")), { code: "ENOENT" });
    assert.match(git(sandbox, ["--git-dir", remotePath, "show-ref", "--verify", "refs/heads/main"]), /refs\/heads\/main/);
  } finally {
    if (priorTemplateDirectory === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = priorTemplateDirectory;
    await rm(sandbox, { recursive: true, force: true });
  }
});
