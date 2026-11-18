/**
 * Journey copy rows for a non-coder (journey 2.3.26/2.3.27 FIX-ROWS):
 * J-13 never "URL not assigned yet" on deleting/deleted; J-14 a private repo
 * never leads with "make it public"; J-17 the live message says how long it
 * took and the estimate has no billing jargon; J-18 while deploying, the
 * stage, elapsed time and what happens next. J-16 lives in test/balance.mjs.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "api-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-copy-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");
const { deployingProgress, plainDuration } = await import("../dist/tools/deploy-status.js");

async function call(name, args, routes) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "copy", version: "1" });
  await client.connect(clientSide);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const [status, body] = routes[path] ?? [404, { code: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    return JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

test("J-13: deleting and deleted never say 'URL not assigned yet'", async () => {
  for (const status of ["deleting", "deleted"]) {
    const row = { id: "op-d", operation_deployment_id: "op-d", app_name: "gone", status, run_id: "run-d" };
    const single = await call("varity_deploy_status", { deployment_id: "op-d" }, {
      "/api/deployments/op-d": [200, { deployment: row }],
      "/api/deployments/runs/run-d": [200, { public_status: status }],
    });
    const list = await call("varity_deploy_status", {}, { "/api/deployments": [200, { deployments: [row] }] });
    for (const out of [single, list]) {
      assert.doesNotMatch(out.message, /URL not assigned yet/, `${status}: ${out.message}`);
      assert.match(out.message, new RegExp(status));
    }
  }
});

test("J-14: a private repository is explained plainly and offers the folder upload, then private paths, before 'make it public'", async () => {
  const out = await call("varity_deploy", { repo_url: "https://github.com/acme/secret-app" }, {
    "/api/deployments": [422, { code: "source_repository_unreadable", message: "supplied token cannot read" }],
  });
  assert.equal(out.error.code, "source_repository_unreadable");
  assert.match(out.error.message, /private or does not exist/);
  assert.match(out.error.message, /nothing was deployed and nothing was charged/i);
  const suggestion = out.error.suggestion;
  const template = suggestion.indexOf("varity_list_templates");
  const image = suggestion.indexOf("image argument");
  const publish = suggestion.indexOf("--visibility public");
  assert.ok(template >= 0 && image >= 0 && publish > template && publish > image, suggestion);
  assert.match(suggestion, /ask first/);
  // U-6 replaces the interim copy: uploading the folder (private) is offered first.
  const upload = suggestion.indexOf("upload your project folder");
  assert.ok(upload >= 0 && upload < template, suggestion);
});

test("J-17: the live message states how long it took", async () => {
  const out = await call("varity_deploy_status", { deployment_id: "op-l" }, {
    "/api/deployments/op-l": [200, { deployment: { id: "op-l", status: "live", run_id: "run-l", url: "https://shop.varity.app" } }],
    "/api/deployments/runs/run-l": [200, {
      public_status: "live", stage: "terminal", accepted_at: "2026-11-18T00:03:09Z",
      outcome: { classification: "succeeded", stage: "terminal", terminal_at: "2026-11-18T00:03:31Z" },
    }],
  });
  assert.equal(out.message, "Deployment op-l: live at https://shop.varity.app. It took 22 seconds to go live.");
});

test("J-17: the estimate is in plain words; the served note stays exact in data", async () => {
  const note = "Up to $7/mo for this reserved deployment, prorated by running time";
  const out = await call("varity_cost_calculator", { app_profile: "web-app" }, {
    "/api/pricing": [200, { profile: "web-app", currency: "USD", monthly_max_usd: 7, billing_model: "reserved_monthly_max_prorated", billing_note: note, mode: "dynamic" }],
  });
  assert.equal(out.message,
    "web-app: up to $7.00/month (monthly maximum, USD). It is charged only for the time it runs, and never more than that in a month. " +
    "Traffic alone does not change an app's monthly price.");
  assert.doesNotMatch(out.message, /pricing interface|reserved deployment|prorated/);
  assert.equal(out.data.billing_note, note);
});

test("J-17/V9-9: an hourly (machine) projection never carries the app traffic line", async () => {
  const out = await call("varity_cost_calculator", { subdomain: "vm-1" }, {
    "/api/deployments/vm-1": [200, { deployment: { id: "vm-1", status: "live", billing: { currency: "USD", hourly_cost_usd: 0.05 } } }],
  });
  assert.doesNotMatch(out.message, /Traffic alone/);
});

test("J-18: while deploying, the stage, time so far and what happens next", async () => {
  const now = Date.now();
  const out = await call("varity_deploy_status", { deployment_id: "op-p" }, {
    "/api/deployments/op-p": [200, { deployment: { id: "op-p", status: "deploying", run_id: "run-p" } }],
    "/api/deployments/runs/run-p": [200, {
      public_status: "deploying", stage: "build", progress: { stage: "allocation" },
      accepted_at: new Date(now - 125_000).toISOString(),
      execution_deadline_at: new Date(now + 475_000).toISOString(),
    }],
  });
  assert.match(out.message, /^Deployment op-p: deploying \(URL not assigned yet\)\. Now finding a server for your app, 2 minutes \d+ seconds so far\. Next, Varity starts it and checks that it responds\. If it is not live by \d\d:\d\d UTC, Varity stops trying and reports why\.$/);
  assert.equal(out.data.run_stage, "allocation");
});

test("J-18: the optional attempt field, when served, says which try", async () => {
  const now = Date.parse("2026-11-18T00:10:00Z");
  const base = { status: "deploying", outcome: null, stage: "health", accepted_at: "2026-11-18T00:07:00Z" };
  assert.equal(deployingProgress(base, now),
    "Now starting your app on a server and checking that it responds, 3 minutes so far. Next, it gets its web address.");
  assert.equal(deployingProgress({ ...base, attempt: 2 }, now),
    "Now starting your app on a server and checking that it responds (attempt 2, 3 minutes so far). Next, it gets its web address.");
  const served = await call("varity_deploy_status", { deployment_id: "op-a" }, {
    "/api/deployments/op-a": [200, { deployment: { id: "op-a", status: "deploying", run_id: "run-a" } }],
    "/api/deployments/runs/run-a": [200, {
      public_status: "deploying", stage: "build", accepted_at: new Date(Date.now() - 30_000).toISOString(),
      progress: { stage: "provider_attempt", attempt: 3 },
    }],
  });
  assert.match(served.message, /Now starting your app on a server \(attempt 3, \d+ seconds so far\)\. Next, Varity checks that it responds and gives it its web address\./);
  assert.doesNotMatch(served.message, /provider/i);
  assert.equal(served.data.run_stage, "provider_attempt");
});

test("J-18: before any attempt (no progress block) only the elapsed time is said; the top-level stage is not read", async () => {
  const out = await call("varity_deploy_status", { deployment_id: "op-b" }, {
    "/api/deployments/op-b": [200, { deployment: { id: "op-b", status: "deploying", run_id: "run-b" } }],
    "/api/deployments/runs/run-b": [200, { public_status: "deploying", stage: "build", accepted_at: new Date(Date.now() - 10_000).toISOString() }],
  });
  assert.match(out.message, /^Deployment op-b: deploying \(URL not assigned yet\)\. \d+ seconds so far\.$/);
  assert.equal("run_stage" in out.data, false);
});

test("J-18: an unknown stage is never guessed; durations read plainly", () => {
  const now = Date.parse("2026-11-18T00:10:00Z");
  assert.equal(deployingProgress({ status: "deploying", outcome: null, stage: "mystery", accepted_at: "2026-11-18T00:09:00Z" }, now), "1 minute so far.");
  assert.equal(deployingProgress({ status: "deploying", outcome: null }, now), null);
  assert.equal(plainDuration(1000), "1 second");
  assert.equal(plainDuration(61_000), "1 minute 1 second");
});

test("J-18: a run that never served says set-aside amounts are released, never that nothing is charged", async () => {
  const row = { id: "op-x", operation_deployment_id: "op-x", status: "failed", run_id: "run-x", outcome: { classification: "user_workload_failure", code: "health_check_failed" } };
  const out = await call("varity_deploy_status", { deployment_id: "op-x" }, {
    "/api/deployments/op-x": [200, { deployment: row }],
    "/api/deployments/runs/run-x": [200, { public_status: "failed", outcome: row.outcome }],
  });
  assert.match(out.message, /Any amount set aside for this attempt is released automatically/);
  assert.doesNotMatch(out.message, /nothing is being charged|not charged/i);
  const live = await call("varity_deploy_status", { deployment_id: "op-y" }, {
    "/api/deployments/op-y": [200, { deployment: { id: "op-y", status: "live", run_id: "run-y", url: "https://y.varity.app", outcome: { classification: "user_workload_failure" } } }],
    "/api/deployments/runs/run-y": [200, { public_status: "failed" }],
  });
  assert.doesNotMatch(live.message, /released automatically/, "a live app's failed update keeps its running charge");
});

test("J-20: each failed state leads with plain words, never raw codes or 'URL not assigned yet'", async () => {
  const states = [
    [{ classification: "user_workload_failure", stage: "build", code: "build_failed", action_code: "check_logs" }, "The build failed, so the app is not online."],
    [{ classification: "infrastructure_failure", code: "provider_unavailable", retryable: true }, "Varity had a problem starting this app, so the app is not online. This was on Varity's side, so trying again is fine."],
    [{ classification: "expected_rejection", code: "configuration_rejected", action_code: "check_configuration" }, "Varity could not accept this deploy as it is set up, so the app is not online."],
    [{ classification: "cancelled", code: "deployment_cancelled" }, "The latest deploy was cancelled, so the app is not online."],
  ];
  for (const [outcome, plain] of states) {
    const row = { id: "op-z", operation_deployment_id: "op-z", status: "failed", run_id: "run-z", outcome };
    const out = await call("varity_deploy_status", { deployment_id: "op-z" }, {
      "/api/deployments/op-z": [200, { deployment: row }],
      "/api/deployments/runs/run-z": [200, { public_status: "failed", outcome }],
    });
    assert.ok(out.message.startsWith(`Deployment op-z: ${plain}`), out.message);
    assert.doesNotMatch(out.message, /URL not assigned yet|_rejection|_failure|_failed|check_|provider|try again in a few/);
    assert.deepEqual(out.data.outcome, outcome);
  }
  const list = await call("varity_deploy_status", {}, {
    "/api/deployments": [200, { deployments: [{ id: "op-z", app_name: "z", status: "failed", created_at: "2026-11-18T00:00:00Z", run_id: "run-z", outcome: states[0][0] }] }],
  });
  assert.match(list.message, /Most recent: z \(failed\)\. The build failed, so the app is not online\.$/);
});
