import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const { lifecycleTracking } = await import("../dist/utils/cli-bridge.js");

const RUN_ID = "19c9f0b2-5ffa-4391-a096-dd964787f929";

test("lifecycle tracking extracts only a valid durable run reference", () => {
  assert.deepEqual(
    lifecycleTracking(`Redeploy accepted\nTrack it: varitykit app status ${RUN_ID}`),
    {
      runId: RUN_ID,
      statusCommand: `varitykit app status ${RUN_ID}`,
    }
  );
  assert.deepEqual(lifecycleTracking("Redeploy accepted without tracking"), {
    runId: null,
    statusCommand: null,
  });
  assert.deepEqual(lifecycleTracking("varitykit app status not-a-run"), {
    runId: null,
    statusCommand: null,
  });
});

test("lifecycle tools preserve acceptance and never manufacture completion", async () => {
  const [redeploy, setEnv, deletion] = await Promise.all([
    readFile(new URL("../src/tools/redeploy.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/tools/set-env.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/tools/delete-deployment.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [redeploy, setEnv, deletion]) {
    assert.match(source, /lifecycleTracking/);
    assert.match(source, /outcome_unconfirmed/);
    assert.doesNotMatch(source, /goes live in about a minute/i);
  }
  assert.match(deletion, /deleted: false/);
  assert.doesNotMatch(deletion, /billing has stopped/i);
});

test("redeploy is never described as a verified restart", async () => {
  const source = await readFile(new URL("../src/tools/redeploy.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /redeploy or restart/i);
  assert.doesNotMatch(source, /restarts the container/i);
  assert.doesNotMatch(source, /my app is stuck/i);
  assert.match(source, /unchanged configuration may be a no-op/i);
});
