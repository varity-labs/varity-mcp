import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { registerMigrateTool } from "../dist/tools/migrate.js";

function payload(response) {
  return JSON.parse(response.content[0].text);
}

function captureHandler() {
  let handler;
  registerMigrateTool({
    registerTool(_name, _definition, callback) {
      handler = callback;
    },
  });
  return handler;
}

test("migration apply refuses before creating a clone or running a command", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-migrate-refuse-"));
  const receipt = path.join(sandbox, "command-receipt");
  const bin = path.join(sandbox, "bin");
  const previousPath = process.env.PATH;
  const previousTmp = process.env.TMPDIR;
  try {
    await mkdir(bin);
    for (const command of ["git", "varitykit"]) {
      const executable = path.join(bin, command);
      await writeFile(executable, `#!/bin/sh\nprintf ran > "${receipt}"\nexit 1\n`);
      await chmod(executable, 0o700);
    }
    process.env.PATH = bin;
    process.env.TMPDIR = sandbox;
    const result = payload(await captureHandler()({
      github_url: "https://github.com/owner/project",
      dry_run: false,
    }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, "MIGRATION_SOURCE_CUSTODY_REQUIRED");
    await assert.rejects(access(receipt), { code: "ENOENT" });
    assert.deepEqual((await readdir(sandbox)).sort(), ["bin"]);
  } finally {
    process.env.PATH = previousPath;
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("migration preview removes its temporary clone after clone failure", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-migrate-clone-"));
  const bin = path.join(sandbox, "bin");
  const scratch = path.join(sandbox, "scratch");
  const previousPath = process.env.PATH;
  const previousTmp = process.env.TMPDIR;
  try {
    await mkdir(bin);
    await mkdir(scratch);
    const git = path.join(bin, "git");
    await writeFile(git, "#!/bin/sh\nprintf 'clone failed safely' >&2\nexit 1\n");
    await chmod(git, 0o700);
    process.env.PATH = bin;
    process.env.TMPDIR = scratch;
    const result = payload(await captureHandler()({
      github_url: "https://github.com/owner/project",
      dry_run: true,
    }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, "CLONE_FAILED");
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    process.env.PATH = previousPath;
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("migration preview removes its temporary clone after owner preview failure", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "varity-mcp-migrate-preview-"));
  const bin = path.join(sandbox, "bin");
  const scratch = path.join(sandbox, "scratch");
  const previousPath = process.env.PATH;
  const previousTmp = process.env.TMPDIR;
  try {
    await mkdir(bin);
    await mkdir(scratch);
    const git = path.join(bin, "git");
    await writeFile(git, "#!/bin/sh\nfor arg in \"$@\"; do target=\"$arg\"; done\n/bin/mkdir -p \"$target\"\nexit 0\n");
    await chmod(git, 0o700);
    const varitykit = path.join(bin, "varitykit");
    await writeFile(varitykit, "#!/bin/sh\nprintf 'preview failed safely' >&2\nexit 1\n");
    await chmod(varitykit, 0o700);
    process.env.PATH = bin;
    process.env.TMPDIR = scratch;
    const result = payload(await captureHandler()({
      github_url: "https://github.com/owner/project",
      dry_run: true,
    }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, "MIGRATION_PREVIEW_FAILED");
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    process.env.PATH = previousPath;
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await rm(sandbox, { recursive: true, force: true });
  }
});
