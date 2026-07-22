/**
 * Regression test for AK-022: varity_deploy_logs must honestly carry the
 * public API's partial-completeness / freshness signal instead of silently
 * dropping it. The gateway sets `complete: false` (+ `warning_code`,
 * `observed_at`) when a returned log window may be missing recent lines.
 * getDeploymentLogs must pass those fields through unchanged.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

process.env["VARITY_API_KEY"] = "test-key";

// Load the compiled module (built before running this test)
const { getDeploymentLogs } = await import("../dist/utils/public-api.js");

function mockFetch(payload) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  });
  return () => { globalThis.fetch = original; };
}

test("partial window: complete/observed_at/warning_code pass through", async () => {
  const restore = mockFetch({
    lines: [{ message: "hello" }],
    count: 1,
    complete: false,
    observed_at: "2026-07-22T00:00:00Z",
    warning_code: "logs_incomplete",
  });
  try {
    const data = await getDeploymentLogs("deploy-1", 100);
    assert.equal(data.complete, false);
    assert.equal(data.observed_at, "2026-07-22T00:00:00Z");
    assert.equal(data.warning_code, "logs_incomplete");
  } finally {
    restore();
  }
});

test("complete window: complete true, no warning_code", async () => {
  const restore = mockFetch({
    lines: [{ message: "hello" }],
    count: 1,
    complete: true,
    observed_at: "2026-07-22T00:00:00Z",
  });
  try {
    const data = await getDeploymentLogs("deploy-1", 100);
    assert.equal(data.complete, true);
    assert.equal(data.warning_code, undefined);
  } finally {
    restore();
  }
});

test("older gateway omitting the fields yields undefined, not a throw", async () => {
  const restore = mockFetch({ lines: [], count: 0 });
  try {
    const data = await getDeploymentLogs("deploy-1", 100);
    assert.equal(data.complete, undefined);
    assert.equal(data.observed_at, undefined);
  } finally {
    restore();
  }
});
