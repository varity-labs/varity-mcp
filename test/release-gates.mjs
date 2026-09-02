import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertAliasesAbsent, inspectAlias, registryRequest } from "../scripts/release-alias-gate.mjs";
import { validateReleaseEvidence } from "../scripts/validate-release-evidence.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const version = "2.3.17";
const bearer = "release-bearer-that-must-remain-opaque";
const registryCredential = "github-token-that-must-remain-opaque";
const registryBearer = "ghcr-bearer-that-must-remain-opaque";
const alias = "ghcr.io/varity-labs/varity-mcp:2.3.17";
const manifestUnknown = JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] });

function mockTransport(manifestOutcome, { authOutcome, calls = [] } = {}) {
  let call = 0;
  return {
    calls,
    request: async (input) => {
      calls.push(input);
      if (call++ === 0) return authOutcome ?? { status: 200, body: JSON.stringify({ token: registryBearer }) };
      if (manifestOutcome instanceof Error) throw manifestOutcome;
      return manifestOutcome;
    },
  };
}

test("authenticated GHCR manifest probe binds absence to the exact repository and alias", async () => {
  const transport = mockTransport({ status: 404, body: manifestUnknown });
  assert.equal(await inspectAlias(alias, { actor: "release-actor", token: registryCredential, request: transport.request }), "absent");
  assert.equal(transport.calls.length, 2);
  const authUrl = new URL(transport.calls[0].url);
  assert.equal(authUrl.origin + authUrl.pathname, "https://ghcr.io/token");
  assert.equal(authUrl.searchParams.get("service"), "ghcr.io");
  assert.equal(authUrl.searchParams.get("scope"), "repository:varity-labs/varity-mcp:pull");
  assert.equal(transport.calls[1].url, "https://ghcr.io/v2/varity-labs/varity-mcp/manifests/2.3.17");
  assert.match(transport.calls[0].headers.Authorization, /^Basic /);
  assert.equal(transport.calls[1].headers.Authorization, `Bearer ${registryBearer}`);
});

test("malformed or non-GHCR references are rejected before any credential-bearing request", async () => {
  for (const reference of [
    "docker.io/varity-labs/varity-mcp:2.3.17",
    "ghcr.io/varity-labs/varity-mcp@sha256:abc",
    "ghcr.io/varity-labs/varity-mcp:../../token",
  ]) {
    let called = false;
    await assert.rejects(
      assertAliasesAbsent([reference], {
        actor: "release-actor",
        token: registryCredential,
        request: async () => { called = true; },
      }),
      /reference is malformed/,
    );
    assert.equal(called, false);
  }
});

test("the two-alias workflow validates a malformed second ref before reading a token or probing the valid first ref", async () => {
  let tokenReads = 0;
  let requests = 0;
  const options = {
    actor: "release-actor",
    get token() { tokenReads += 1; return registryCredential; },
    request: async () => { requests += 1; return { status: 404, body: manifestUnknown }; },
  };
  await assert.rejects(
    assertAliasesAbsent([alias, "ghcr.io/varity-labs/varity-mcp:../../token"], options),
    /reference is malformed/,
  );
  assert.equal(tokenReads, 0);
  assert.equal(requests, 0);
});

test("the default registry transport rejects oversized diagnostics before reading them", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let bodyRead = false;
  globalThis.fetch = async () => ({
    status: 404,
    headers: { get: () => String(64 * 1024 + 1) },
    body: { getReader: () => { bodyRead = true; } },
  });
  await assert.rejects(
    registryRequest({ url: "https://ghcr.io/token", headers: {} }),
    /size limit/,
  );
  assert.equal(bodyRead, false);
});

test("the default registry transport cancels a no-content-length stream before allocating beyond 64 KiB", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let reads = 0;
  let cancelled = false;
  globalThis.fetch = async () => ({
    status: 404,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          reads += 1;
          return reads === 1
            ? { done: false, value: new Uint8Array(64 * 1024) }
            : { done: false, value: new Uint8Array(1) };
        },
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
    },
  });
  await assert.rejects(
    registryRequest({ url: "https://ghcr.io/token", headers: {} }),
    /size limit/,
  );
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test("only HTTP 404 plus MANIFEST_UNKNOWN is absent; every other registry outcome fails closed", async () => {
  const outcomes = [
    { name: "present", value: { status: 200, body: "" }, expected: /already exists/ },
    { name: "unauthorized", value: { status: 401, body: "unauthorized" } },
    { name: "forbidden", value: { status: 403, body: "forbidden" } },
    { name: "not-found-without-code", value: { status: 404, body: "not found" } },
    { name: "not-found-wrong-code", value: { status: 404, body: JSON.stringify({ errors: [{ code: "NAME_UNKNOWN" }] }) } },
    { name: "rate-limited", value: { status: 429, body: "too many requests" } },
    { name: "server-error", value: { status: 500, body: "internal" } },
    { name: "unavailable", value: { status: 503, body: "unavailable" } },
    { name: "malformed", value: { status: 404, body: "{" } },
    { name: "network", value: new Error("network failure") },
  ];
  for (const outcome of outcomes) {
    const transport = mockTransport(outcome.value);
    await assert.rejects(
      assertAliasesAbsent([alias], { actor: "release-actor", token: registryCredential, request: transport.request }),
      outcome.expected ?? /absence could not be confirmed/,
      outcome.name,
    );
  }
});

test("authentication and token-response failures are indeterminate and credential opaque", async () => {
  const authOutcomes = [
    { status: 401, body: registryCredential },
    { status: 403, body: "forbidden" },
    { status: 429, body: "limited" },
    { status: 500, body: "failure" },
    { status: 503, body: "unavailable" },
    { status: 200, body: "{" },
    { status: 200, body: JSON.stringify({ token: "" }) },
  ];
  for (const authOutcome of authOutcomes) {
    const transport = mockTransport({ status: 404, body: manifestUnknown }, { authOutcome });
    await assert.rejects(
      assertAliasesAbsent([alias], { actor: "release-actor", token: registryCredential, request: transport.request }),
      (error) => {
        assert.match(error.message, /absence could not be confirmed/);
        assert.doesNotMatch(error.message, new RegExp(registryCredential));
        assert.doesNotMatch(error.message, new RegExp(registryBearer));
        return true;
      },
    );
  }

  for (const missing of [{ actor: "", token: registryCredential }, { actor: "release-actor", token: "" }]) {
    await assert.rejects(assertAliasesAbsent([alias], missing), /absence could not be confirmed/);
  }
});

test("a promotion-time recheck closes the initial-check TOCTOU window", async () => {
  let manifestCalls = 0;
  const request = async (input) => {
    if (input.url.startsWith("https://ghcr.io/token")) return { status: 200, body: JSON.stringify({ token: registryBearer }) };
    return manifestCalls++ === 0
      ? { status: 404, body: manifestUnknown }
      : { status: 200, body: "" };
  };
  const options = { actor: "release-actor", token: registryCredential, request };
  await assert.doesNotReject(assertAliasesAbsent([alias], options));
  await assert.rejects(assertAliasesAbsent([alias], options), /already exists/);
});

function makeEvidence(t) {
  const root = mkdtempSync(path.join(tmpdir(), "varity-mcp-release-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "acceptance.stderr": "",
    "acceptance.stdout": `ACCEPTANCE PASS digest=${digest} version=${version} health=exact tools/list=exact tools/call=real\n`,
    "auth-fixture.stderr": "release-auth-fixture: ready\n",
    "auth-fixture.stdout": "",
    "container.stderr": "",
    "container.stdout": "runtime ready\n",
    "gate.receipt.json": JSON.stringify({
      version,
      serverInfoVersion: version,
      anonymous: "rejected",
      tools: ["varity_search_docs"],
      toolsCall: { name: "varity_search_docs", result: "bounded-public-docs-pass" },
    }),
    "gate.stderr": "",
    "gate.stdout": [
      `exact HTTP release ${version} identified`,
      "exact public-read tool allowlist",
      "public documentation search returned one bounded result",
      "hosted-mcp-release-function-gate: passed",
    ].join("\n"),
    "health.json": JSON.stringify({ status: "ok", transport: "http", version }),
    "release.receipt.json": JSON.stringify({ acceptedDigest: digest, version, acceptance: "PASS" }),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
  return root;
}

function validate(root) {
  return validateReleaseEvidence({ root, bearer, expectedDigest: digest, expectedVersion: version });
}

test("self-contained evidence proves exact digest, health, tools/list, real tools/call, and PASS", (t) => {
  const root = makeEvidence(t);
  assert.doesNotThrow(() => validate(root));
});

test("evidence validation fails closed on bearer exposure, malformed receipts, and scan errors", async (t) => {
  await t.test("bearer exposure", () => {
    const root = makeEvidence(t);
    writeFileSync(path.join(root, "container.stderr"), bearer);
    assert.throws(() => validate(root), /exposed its bearer/);
  });
  await t.test("malformed receipt", () => {
    const root = makeEvidence(t);
    writeFileSync(path.join(root, "release.receipt.json"), "not-json");
    assert.throws(() => validate(root), /invalid release\.receipt\.json/);
  });
  await t.test("non-regular diagnostic", () => {
    const root = makeEvidence(t);
    const diagnostic = path.join(root, "container.stdout");
    unlinkSync(diagnostic);
    symlinkSync(path.join(root, "gate.stdout"), diagnostic);
    assert.throws(() => validate(root), /not a regular file/);
  });
});
