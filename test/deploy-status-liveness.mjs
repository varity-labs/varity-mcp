/**
 * Regression test for VAR-133: varity_deploy_status false-positive "deployed" status.
 *
 * Before the fix, deploy-status.ts set status from the stored JSON (build.success)
 * without ever making an HTTP request to verify the app was live.
 * This meant apps returning HTTP 404 still showed status: "deployed".
 *
 * The fix adds checkLiveness() which probes the URL and returns live=false for non-2xx.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// Load the compiled module (built before running this test)
const { checkLiveness } = await import("../dist/tools/deploy-status.js");

// --- Helpers ---

function mockFetch(statusCode, { throws } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => {
    if (throws) throw new Error(throws);
    return {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
    };
  };
  return () => { globalThis.fetch = original; };
}

// --- Tests ---

test("HTTP 200 → live: true", async () => {
  const restore = mockFetch(200);
  try {
    const result = await checkLiveness("https://varity.app/my-app/");
    assert.equal(result.live, true);
    assert.equal(result.httpStatus, 200);
  } finally {
    restore();
  }
});

test("HTTP 404 → live: false, httpStatus: 404", async () => {
  const restore = mockFetch(404);
  try {
    const result = await checkLiveness("https://varity.app/broken-app/");
    assert.equal(result.live, false);
    assert.equal(result.httpStatus, 404);
  } finally {
    restore();
  }
});

test("HTTP 503 → live: false, httpStatus: 503", async () => {
  const restore = mockFetch(503);
  try {
    const result = await checkLiveness("https://varity.app/crashing-app/");
    assert.equal(result.live, false);
    assert.equal(result.httpStatus, 503);
  } finally {
    restore();
  }
});

test("network error → live: false, no httpStatus", async () => {
  const restore = mockFetch(0, { throws: "ECONNREFUSED" });
  try {
    const result = await checkLiveness("https://varity.app/unreachable/");
    assert.equal(result.live, false);
    assert.equal(result.httpStatus, undefined);
  } finally {
    restore();
  }
});

test("unknown URL → live: false without fetching", async () => {
  // Should short-circuit before calling fetch
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200 }; };
  try {
    const result = await checkLiveness("unknown");
    assert.equal(result.live, false);
    assert.equal(fetchCalled, false, "fetch must not be called for 'unknown' URL");
  } finally {
    globalThis.fetch = original;
  }
});

test("non-http URL → live: false without fetching", async () => {
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200 }; };
  try {
    const result = await checkLiveness("ftp://example.com/foo");
    assert.equal(result.live, false);
    assert.equal(fetchCalled, false, "fetch must not be called for non-http URL");
  } finally {
    globalThis.fetch = original;
  }
});

test("live result includes latency_ms as a non-negative number", async () => {
  const restore = mockFetch(200);
  try {
    const result = await checkLiveness("https://varity.app/my-app/");
    assert.equal(typeof result.latencyMs, "number");
    assert.ok(result.latencyMs >= 0);
  } finally {
    restore();
  }
});
