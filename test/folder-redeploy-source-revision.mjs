/**
 * PLAN-W2 (VERIFY-PLANS W2): redeploying the same folder must keep a dynamic
 * app's settings and its AI Gateway attachment. A same-name create replaces
 * the release's sealed environment (gateway public-api.ts:1308-1324; deploy-api
 * adapter.py:2520-2575), so the MCP looks the app up first and deploys a
 * dynamic app it already runs from this private copy in place, through
 * `POST /api/deployments/:id/source-revision` with a single-use approval
 * (gateway public-api.ts:2088-2300 at 98042b77).
 *
 * Every gateway body comes from fixtures/gateway-98042b77-source-revision.json,
 * copied from the producer source with a line citation per body.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-w2-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");
const { locatorName } = await import("../dist/tools/deploy-private-copy.js");

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/gateway-98042b77-source-revision.json", import.meta.url), "utf8"));
const ORG = "varity-hosted";
const PREFIX = "u1a2b3c4d5e6f7a8";
const APP = "my-site";
const RECORD_ID = "0b7e4f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const OPS_ID = "7d9c1e2f-3a4b-4c5d-9e8f-1a2b3c4d5e6f";
const RUN_ID = "19c9f0b2-5ffa-4391-a096-dd964787f929";
const APPROVAL_ID = "apr_4b1d9e0c";
const sha = (i) => i.toString(16).padStart(40, "0");
const HEAD = sha(1);

const SOURCES = "POST /api/deployments/sources";
const LOCATOR = `GET /api/deployments/${APP}`;
const HOSTED = "POST /api/github/hosted-repositories";
const CHANGES = "POST /api/github/changes";
const CREATE = "POST /api/deployments";
const APPROVALS = "POST /v1/deployment-approvals";
const REVISION = `POST /api/deployments/${RECORD_ID}/source-revision`;
const RUN = `GET /api/deployments/runs/${RUN_ID}`;

const PLACEHOLDERS = {
  "<record id>": RECORD_ID,
  "<ops id>": OPS_ID,
  "<durable id>": OPS_ID,
  "<app>": APP,
  "<org>": ORG,
  "<prefix>": PREFIX,
  "<sha>": sha(900),
  "<approval id>": APPROVAL_ID,
  "<iso>": "2026-11-18T12:00:00.000Z",
  "<run id>": RUN_ID,
  "<relayed deploy-api message>": "This app mounts a persistent volume, so it cannot be updated in place.",
};
/** A fixture body with its placeholders filled. */
function served(name, edit = (body) => body) {
  const text = JSON.stringify(FIXTURE[name].body).replace(/<[a-z ./-]+>/g, (m) => PLACEHOLDERS[m] ?? m);
  return edit(JSON.parse(text));
}
const answer = (name, edit) => [FIXTURE[name].status ?? 200, served(name, edit)];
const detail = (name, edit = (d) => d) => [200, served(name, (body) => ({ deployment: edit(body.deployment) }))];

const UPLOAD_OFF = [404, { code: "uploads_unavailable", message: "Deploying uploaded files is not available yet." }];
const REPO = [201, { repository: { id: 42, owner: ORG, name: `${PREFIX}-${APP}`, full_name: `${ORG}/${PREFIX}-${APP}`, default_branch: "main", private: true } }];
const ACCEPTED_CREATE = [202, { id: OPS_ID, app_name: APP, status: "deploying", run_id: RUN_ID }];

/** `METHOD path` -> a queue of [status, body, headers] (the last repeats), or "throw"; anything else 404 not_found. */
function stubGateway(routes, { clock } = {}) {
  const calls = [];
  const used = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const route = `${init.method} ${new URL(url).pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { route, headers: init.headers, body, index: used[route] ?? 0 };
    calls.push(call);
    used[route] = call.index + 1;
    clock?.(call);
    let reply = routes[route];
    if (Array.isArray(reply) && (Array.isArray(reply[0]) || reply[0] === "throw")) reply = reply[Math.min(call.index, reply.length - 1)];
    if (reply === undefined && route === CHANGES) reply = [201, { branch: body.branch, commit_sha: sha(calls.filter((c) => c.route === CHANGES).length), base_sha: sha(999) }];
    if (reply === "throw") throw new TypeError("fetch failed");
    const [status, payload, headers = {}] = reply ?? [404, { code: "not_found", message: "Not found" }];
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => lower[k.toLowerCase()] ?? null }, json: async () => payload };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function connect() {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "w2-test", version: "1" });
  await client.connect(clientSide);
  return client;
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "mcp-w2-"));
  const dir = join(root, APP);
  mkdirSync(dir);
  writeFileSync(join(dir, "server.js"), "require('http').createServer((q, s) => s.end('ok')).listen(3000)\n");
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const DYNAMIC = detail("detail_dynamic", (d) => ({ ...d, source: { ...d.source, repository_url: `https://github.com/${ORG}/${PREFIX}-${APP}` } }));
const base = (extra = {}) => ({
  [SOURCES]: [UPLOAD_OFF],
  [LOCATOR]: [DYNAMIC],
  [HOSTED]: [REPO],
  [CREATE]: [ACCEPTED_CREATE],
  [APPROVALS]: [answer("approval_created")],
  [REVISION]: [answer("source_revision_accepted", (b) => ({ ...b, commit_sha: HEAD }))],
  ...extra,
});

async function deploy(routes, { clock, args = {} } = {}) {
  const client = await connect();
  const { dir, cleanup } = project();
  const stub = stubGateway(routes, { clock });
  try {
    const result = await client.callTool({ name: "varity_deploy", arguments: { path: dir, ...args } });
    return { isError: Boolean(result.isError), out: JSON.parse(result.content[0].text), calls: stub.calls };
  } finally {
    stub.restore();
    await client.close();
    cleanup();
  }
}

const of = (calls, route) => calls.filter((c) => c.route === route);
/** The routes a run sent, without the upload probe and the billing-copy read that enriches a 503 (`withBillingCopy`). */
const routes = (calls) => calls.map((c) => c.route).filter((r) => r !== SOURCES && r !== "GET /api/pricing");
const UNCONFIRMED = `Check varity_deploy_status with "${APP}" before deploying again.`;

test("T1: a dynamic app this private copy runs is updated in place through an approved source revision, never re-created", async () => {
  const { isError, out, calls } = await deploy(base());
  assert.equal(isError, false, JSON.stringify(out));
  assert.deepEqual(routes(calls), [LOCATOR, HOSTED, CHANGES, APPROVALS, REVISION, RUN]);
  assert.deepEqual(of(calls, APPROVALS)[0].body, { action: { kind: "deploy_revision", target: `deployment:${RECORD_ID}`, fingerprint: HEAD } });
  const [revision] = of(calls, REVISION);
  assert.deepEqual(revision.body, { commit: HEAD });
  assert.equal(revision.headers["X-Varity-Approval-Id"], APPROVAL_ID);
  assert.match(revision.headers["Idempotency-Key"], /^mcp-source-revision:[0-9a-f-]{36}$/);
  assert.equal(out.data.update, "in_place");
  assert.equal(out.data.id, RECORD_ID);
  assert.equal(out.data.source, "varity_private_repository");
  assert.match(out.message, /is updating my-site in place; its settings and any attached AI key are kept\./);
});

test("T2: a static app with the same name is still deployed by the same-name create (it updates in place)", async () => {
  const { isError, calls } = await deploy(base({ [LOCATOR]: [detail("detail_dynamic", (d) => ({ ...d, runtime: "static" }))] }));
  assert.equal(isError, false);
  assert.deepEqual(routes(calls), [LOCATOR, HOSTED, CHANGES, CREATE, RUN]);
});

test("T3: only a served deployment_not_found means a first deploy; an unread answer never becomes a create (R8)", async () => {
  const first = await deploy(base({ [LOCATOR]: [answer("locator_not_found")] }));
  assert.equal(first.isError, false, JSON.stringify(first.out));
  assert.deepEqual(routes(first.calls), [LOCATOR, HOSTED, CHANGES, CREATE, RUN]);
  assert.equal(of(first.calls, CREATE)[0].body.app_name, APP);

  const cases = [
    ["503", [[503, served("ownership_check_unavailable"), { "Retry-After": "20" }]], "ownership_check_unavailable", "Call varity_deploy again with the same path after 20 seconds."],
    ["429", [[429, { code: "rate_limited", message: "Too many requests." }, { "Retry-After": "7" }]], "rate_limited", "Call varity_deploy again with the same path after 7 seconds."],
    ["502", [[502, { code: "deployment_read_unavailable", message: "Deployment detail is temporarily unavailable." }]], "deployment_read_unavailable", "Call varity_deploy again with the same path."],
    ["network", ["throw"], "VARITY_API_UNREACHABLE", "Call varity_deploy again with the same path."],
    ["other 404", [[404, { code: "not_found", message: "Not found" }]], "not_found", "Call varity_deploy again with the same path."],
    ["empty 200", [[200, {}]], "DEPLOYMENT_NOT_FOUND", "Call varity_deploy again with the same path."],
  ];
  for (const [name, locator, code, action] of cases) {
    const { isError, out, calls } = await deploy(base({ [LOCATOR]: locator }));
    assert.equal(isError, true, name);
    assert.equal(out.error.code, code, name);
    assert.equal(out.error.suggestion, action, name);
    assert.match(out.error.message, /nothing was deployed or charged\./i, name);
    assert.deepEqual(routes(calls), [LOCATOR], name);
  }
});

test("T4: an app of that name the copy cannot update in place is refused before anything is saved", async () => {
  const otherRepo = `https://github.com/${ORG}/${PREFIX}-other`;
  const cases = [
    ["another hosted repo", detail("detail_dynamic", (d) => ({ ...d, source: { ...d.source, repository_url: otherRepo } })), "APP_NAME_IN_USE", [LOCATOR, HOSTED]],
    ["not GitHub", detail("detail_dynamic", (d) => ({ ...d, source: { ...d.source, repository_url: "https://gitlab.com/acme/my-site" } })), "APP_NAME_IN_USE", [LOCATOR]],
    ["template", detail("detail_dynamic", (d) => ({ ...d, source: { type: "template", template_id: "tpl" } })), "APP_NAME_IN_USE", [LOCATOR]],
    ["image", detail("detail_dynamic", (d) => ({ ...d, source: { type: "image" } })), "APP_NAME_IN_USE", [LOCATOR]],
    ["legacy record", detail("detail_dynamic", (d) => ({ ...d, membership: "registry_legacy" })), "APP_NAME_IN_USE", [LOCATOR]],
    ["owner-only source", detail("detail_dynamic", (d) => ({ ...d, source: served("detail_owner_only_source") })), "DEPLOYMENT_SOURCE_UNCONFIRMED", [LOCATOR]],
    ["deleted", detail("detail_deleted"), "APP_BEING_DELETED", [LOCATOR]],
    ["deleting", detail("detail_dynamic", (d) => ({ ...d, status: "deleting" })), "APP_BEING_DELETED", [LOCATOR]],
  ];
  for (const [name, locator, code, sent] of cases) {
    const { isError, out, calls } = await deploy(base({ [LOCATOR]: [locator] }));
    assert.equal(isError, true, name);
    assert.equal(out.error.code, code, name);
    assert.match(out.error.message, /nothing was deployed or charged\./i, name);
    assert.match(out.error.suggestion, /varity_deploy/, name);
    assert.deepEqual(routes(calls), sent, name);
  }
});

test("T5: source-revision refusals keep the live app and never fall back to a create; an ambiguous answer is resent once with the same key", async () => {
  const lead = "Varity saved this folder, but the update was not started: ";
  const kept = `Call varity_deploy_status with "${APP}" to see its state; to deploy this folder as a separate app, call varity_deploy again with the same path and a different app_name.`;
  const refusals = [
    ["update in progress", [answer("update_in_progress")], "deployment_update_in_progress", `Wait until varity_deploy_status with "${APP}" shows it live, then call varity_deploy again with the same path.`],
    ["unavailable", [answer("source_revision_unavailable")], "source_revision_unavailable", `Call varity_deploy_status with "${APP}" to see its state; to deploy this folder as a separate app, call varity_deploy again with the same path and a different app_name.`],
    ["runtime not started", [answer("runtime_not_started")], "runtime_not_started", `Call varity_deploy_status with "${APP}" to see its state; to deploy this folder as a separate app, call varity_deploy again with the same path and a different app_name.`],
    ["unsupported", [[422, { code: "source_revision_unsupported", message: "Only a web service deployed from a repository can deploy a new commit in place." }]], "source_revision_unsupported", kept],
    ["gone", [answer("locator_not_found")], "deployment_not_found", kept],
    ["other 4xx", [answer("idempotency_key_reused")], "idempotency_key_reused", "Call varity_deploy again with the same path."],
    ["credential", [answer("repository_credential_required")], "repository_credential_required", "Call varity_deploy again with the same path in a minute; if it repeats, call varity_doctor to check the deploy key."],
    ["rate limited", [[429, { code: "rate_limited", message: "Too many requests." }, { "Retry-After": "30" }]], "rate_limited", "Call varity_deploy again with the same path after 30 seconds."],
  ];
  for (const [name, reply, code, action] of refusals) {
    const { isError, out, calls } = await deploy(base({ [REVISION]: reply }));
    assert.equal(isError, true, name);
    assert.equal(out.error.code, code, name);
    assert.ok(out.error.message.startsWith(lead), `${name}: ${out.error.message}`);
    assert.equal(out.error.suggestion, action, name);
    if (action === kept) assert.match(out.error.message, / The live app was not changed\.$/, name);
    assert.equal(of(calls, CREATE).length, 0, name);
    assert.equal(of(calls, REVISION).length, 1, name);
  }

  const unavailable = answer("deploy_service_unavailable");
  const accepted = answer("source_revision_accepted", (b) => ({ ...b, commit_sha: HEAD }));
  const firstAnswer500 = await deploy(base({ [REVISION]: [[500, { code: "redeploy_failed", message: "The commit could not be deployed." }], accepted] }));
  assert.equal(firstAnswer500.isError, false, JSON.stringify(firstAnswer500.out));
  assert.equal(of(firstAnswer500.calls, REVISION).length, 2);

  const approvalLost = await deploy(base({ [REVISION]: [unavailable], [APPROVALS]: [answer("approval_created"), [503, { code: "approval_store_unavailable", message: "Approvals are unavailable." }]] }));
  assert.equal(approvalLost.isError, true);
  assert.equal(approvalLost.out.error.suggestion, UNCONFIRMED);
  assert.match(approvalLost.out.error.message, /whether the update started is unconfirmed/);
  assert.equal(of(approvalLost.calls, REVISION).length, 1);

  const resent = await deploy(base({ [REVISION]: [unavailable, accepted] }));
  assert.equal(resent.isError, false, JSON.stringify(resent.out));
  assert.equal(of(resent.calls, APPROVALS).length, 2);
  const [a, b] = of(resent.calls, REVISION);
  assert.equal(b.headers["Idempotency-Key"], a.headers["Idempotency-Key"]);
  assert.equal(b.headers["X-Varity-Approval-Id"], APPROVAL_ID);
  assert.equal(resent.out.data.update, "in_place");

  for (const [name, second] of [
    ["503 twice", unavailable],
    ["503 then key reused", answer("idempotency_key_reused")],
    ["503 then update in progress", answer("update_in_progress")],
    ["network twice", "throw"],
  ]) {
    const first = name === "network twice" ? "throw" : unavailable;
    const { isError, out, calls } = await deploy(base({ [REVISION]: [first, second] }));
    assert.equal(isError, true, name);
    assert.match(out.error.message, /whether the update started is unconfirmed/, name);
    assert.doesNotMatch(out.error.message, /Nothing was deployed/, name);
    assert.equal(out.error.suggestion, UNCONFIRMED, name);
    assert.equal(of(calls, REVISION).length, 2, name);
    assert.equal(of(calls, CREATE).length, 0, name);
  }
});

test("T6: a name that never went live (durable_only) is deployed by the create, with no approval", async () => {
  const { isError, calls } = await deploy(base({ [LOCATOR]: [detail("detail_durable_only")] }));
  assert.equal(isError, false);
  assert.deepEqual(routes(calls), [LOCATOR, HOSTED, CHANGES, CREATE, RUN]);
});

test("T7: the update starts only with at least 45 s left before the 230 s hard deadline, and no request outlives it", async () => {
  const realNow = Date.now;
  const t0 = realNow();
  let offset = 0;
  Date.now = () => t0 + offset;
  try {
    // The commit returns at 186 s: 44 s are left, too little for the gateway's source revision.
    const late = await deploy(base(), { clock: (call) => { if (call.route === CHANGES) offset = 186_000; } });
    assert.equal(late.isError, true);
    assert.equal(late.out.error.code, "DEPLOY_NOT_STARTED");
    assert.equal(late.out.error.message, "Varity saved this folder, but there was not enough time left to start the update. Nothing was deployed or charged.");
    assert.equal(late.out.error.suggestion, "Call varity_deploy again with the same path.");
    assert.equal(of(late.calls, APPROVALS).length, 0);
    assert.equal(of(late.calls, REVISION).length, 0);

    // At 184 s, 46 s are left: the update starts, each request's timeout is cut to what is left
    // (read from the abort timer the client arms just before its fetch), and the resend is skipped
    // once under 15 s remain.
    offset = 0;
    const realSetTimeout = globalThis.setTimeout;
    let lastDelay;
    const timeouts = {};
    globalThis.setTimeout = (fn, ms, ...rest) => { lastDelay = ms; return realSetTimeout(fn, ms, ...rest); };
    let tight;
    try {
      tight = await deploy(base({ [REVISION]: [answer("deploy_service_unavailable")] }), {
        clock: (call) => {
          if (call.route === APPROVALS || call.route === REVISION) timeouts[call.route] = lastDelay;
          if (call.route === CHANGES) offset = 184_000;
          if (call.route === REVISION) offset = 216_000;
        },
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.ok(timeouts[APPROVALS] <= 46_000, String(timeouts[APPROVALS]));
    assert.ok(timeouts[REVISION] <= 46_000, String(timeouts[REVISION]));
    assert.equal(tight.isError, true);
    assert.equal(of(tight.calls, REVISION).length, 1);
    assert.equal(tight.out.error.suggestion, UNCONFIRMED);
  } finally {
    Date.now = realNow;
  }
});

test("T8: a busy approval answers its wait and sends no source revision", async () => {
  const { isError, out, calls } = await deploy(base({ [APPROVALS]: [[429, { code: "too_many_pending_approvals", message: "Too many pending approvals." }, { "Retry-After": "12" }]] }));
  assert.equal(isError, true);
  assert.equal(out.error.code, "too_many_pending_approvals");
  assert.ok(out.error.message.startsWith("Varity saved this folder, but the update was not started: "));
  assert.equal(out.error.suggestion, "Call varity_deploy again with the same path after 12 seconds.");
  assert.equal(of(calls, REVISION).length, 0);
});

test("T9: an in-place update says the app keeps its storage settings when volume arguments were given", async () => {
  const { isError, out, calls } = await deploy(base(), { args: { volume_size: 1, volume_path: "/data" } });
  assert.equal(isError, false, JSON.stringify(out));
  assert.deepEqual(of(calls, REVISION)[0].body, { commit: HEAD });
  assert.match(out.message, /any attached AI key are kept\. Its storage settings are unchanged\. /);
});

test("the locator name is the gateway's own app-name normalization (deploy-validation.ts:26-41)", () => {
  for (const [name, slug] of [["a--b", "a-b"], ["My App", "my-app"], ["-x-y-", "x-y"], ["org/my-site", "my-site"], ["a".repeat(70), "a".repeat(63)]]) {
    assert.equal(locatorName(name), slug, name);
  }
});
