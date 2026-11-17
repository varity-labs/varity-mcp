/**
 * H1 test (6): `npm run check:architecture` refuses a remote toolset whose
 * static module graph (from `src/toolsets/remote.ts`) reaches `node:fs`,
 * `node:child_process`, `node:os` or the CLI bridge.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { remoteGraphViolations } = require("../scripts/check-architecture.cjs");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "remote-graph-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test("this repository's remote toolset graph is clean", () => {
  assert.deepEqual(remoteGraphViolations(repoRoot), []);
});

for (const banned of ["node:fs", "node:fs/promises", "node:child_process", "node:os", "fs"]) {
  test(`a transitive import of ${banned} fails the check`, () => {
    const root = fixture({
      "src/toolsets/remote.ts": 'import { registerX } from "../tools/x.js";\nexport const r = registerX;\n',
      "src/tools/x.ts": `import { helper } from "../utils/h.js";\nexport const registerX = helper;\n`,
      "src/utils/h.ts": `import * as m from "${banned}";\nexport const helper = m;\n`,
    });
    try {
      const violations = remoteGraphViolations(root);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.match(violations[0], /src\/utils\/h\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("reaching the CLI bridge fails the check, and type-only imports are ignored", () => {
  const root = fixture({
    "src/toolsets/remote.ts": 'import type { T } from "../utils/cli-bridge.js";\nexport { stripAnsi } from "../utils/cli-bridge.js";\n',
    "src/utils/cli-bridge.ts": "export const stripAnsi = (s: string) => s;\n",
  });
  try {
    const violations = remoteGraphViolations(root);
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0], /cli-bridge/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing remote toolset entry is itself a violation", () => {
  const root = fixture({ "src/server.ts": "export {};\n" });
  try {
    assert.equal(remoteGraphViolations(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
