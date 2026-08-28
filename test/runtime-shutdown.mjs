import assert from "node:assert/strict";
import { test } from "node:test";

const { createRuntimeShutdownCoordinator } = await import("../dist/runtime-shutdown.js");

test("transport close failure still yields telemetry custody and a failed shutdown", async () => {
  const events = [];
  const shutdown = createRuntimeShutdownCoordinator(async () => {
    events.push("telemetry");
  });
  shutdown.setRuntimeShutdown(async () => {
    events.push("transport");
    throw new Error("synthetic transport close failure");
  });

  await assert.rejects(
    shutdown.shutdown(true),
    /synthetic transport close failure/,
    "a failed transport close must not be reported as a successful shutdown"
  );
  assert.deepEqual(events, ["transport", "telemetry"],
    "telemetry shutdown must run even after transport cleanup rejects");
});
