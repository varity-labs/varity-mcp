import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";


test("redeploy tool never presents configuration replay as verified restart", async () => {
  const source = await readFile(new URL("../src/tools/redeploy.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /redeploy or restart/i);
  assert.doesNotMatch(source, /restarts the container/i);
  assert.doesNotMatch(source, /my app is stuck/i);
  assert.doesNotMatch(source, /after changing (?:an )?image|after changing source/i);
  assert.match(source, /unchanged configuration may be a no-op/i);
});
