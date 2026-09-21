/**
 * HTTP reachability is an observation, not lifecycle authority. The public API
 * owns deployment status; this probe records response/network evidence without
 * rewriting private, POST-only, or transiently unavailable apps as unhealthy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// Load the compiled module (built before running this test)
const { applyLiveness, checkLiveness } = await import("../dist/tools/deploy-status.js");

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

test("HTTP 200 is a reachable observation", async () => {
  const restore = mockFetch(200);
  try {
    const result = await checkLiveness("https://varity.app/my-app/");
    assert.equal(result.outcome, "reachable");
    assert.equal(result.http_status, 200);
  } finally {
    restore();
  }
});

test("HTTP 404 is a distinct HTTP response, not a lifecycle status", async () => {
  const restore = mockFetch(404);
  try {
    const result = await checkLiveness("https://varity.app/broken-app/");
    assert.equal(result.outcome, "http_error");
    assert.equal(result.http_status, 404);
  } finally {
    restore();
  }
});

test("HTTP 503 is a distinct HTTP response", async () => {
  const restore = mockFetch(503);
  try {
    const result = await checkLiveness("https://varity.app/crashing-app/");
    assert.equal(result.outcome, "http_error");
    assert.equal(result.http_status, 503);
  } finally {
    restore();
  }
});

test("network error is distinct from an HTTP response", async () => {
  const restore = mockFetch(0, { throws: "ECONNREFUSED" });
  try {
    const result = await checkLiveness("https://varity.app/unreachable/");
    assert.equal(result.outcome, "network_error");
    assert.equal(result.http_status, undefined);
  } finally {
    restore();
  }
});

test("unknown URL is not applicable and is not fetched", async () => {
  // Should short-circuit before calling fetch
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200 }; };
  try {
    const result = await checkLiveness("unknown");
    assert.equal(result.outcome, "not_applicable");
    assert.equal(fetchCalled, false, "fetch must not be called for 'unknown' URL");
  } finally {
    globalThis.fetch = original;
  }
});

test("non-http URL is not applicable and is not fetched", async () => {
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200 }; };
  try {
    const result = await checkLiveness("ftp://example.com/foo");
    assert.equal(result.outcome, "not_applicable");
    assert.equal(fetchCalled, false, "fetch must not be called for non-http URL");
  } finally {
    globalThis.fetch = original;
  }
});

test("reachable result includes latency as a non-negative number", async () => {
  const restore = mockFetch(200);
  try {
    const result = await checkLiveness("https://varity.app/my-app/");
    assert.equal(typeof result.latency_ms, "number");
    assert.ok(result.latency_ms >= 0);
  } finally {
    restore();
  }
});

test("HTTP probes never overwrite owner lifecycle status", async () => {
  const restore = mockFetch(401);
  try {
    const deployments = [{
      id: "private-app",
      name: "private-app",
      appName: "private-app",
      runtime: "container",
      url: "https://private.varity.app/",
      status: "live",
      timestamp: "2026-09-21T00:00:00Z",
    }];
    await applyLiveness(deployments);
    assert.equal(deployments[0].status, "live");
    assert.deepEqual(deployments[0].http_probe, {
      outcome: "http_error",
      http_status: 401,
      latency_ms: deployments[0].http_probe.latency_ms,
    });
  } finally {
    restore();
  }
});
