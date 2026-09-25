/**
 * Lifecycle tools call the one public-API client (no CLI subprocess) and
 * report the gateway's own run `public_status`; the MCP invents no status
 * words, and an unreadable run is `null` (unobserved), never success.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env["VARITY_GATEWAY_URL"] = "https://gw.test";
process.env["VARITY_API_KEY"] = "api-key";

const { lifecycleTracking } = await import("../dist/utils/cli-bridge.js");
const { lifecycleAcceptance } = await import("../dist/utils/lifecycle-acceptance.js");
const { deployAccepted, defaultAppName } = await import("../dist/tools/deploy.js");
const { redeployAccepted } = await import("../dist/tools/redeploy.js");
const { deleteAccepted } = await import("../dist/tools/delete-deployment.js");
const { templateDeployAccepted } = await import("../dist/tools/agent.js");

const RUN_ID = "19c9f0b2-5ffa-4391-a096-dd964787f929";

function stubRunView(status, payload) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function payload(response) {
  return JSON.parse(response.content[0].text);
}

test("lifecycle tracking extracts only a valid durable run reference", () => {
  assert.deepEqual(lifecycleTracking(`Accepted\nTrack it: varitykit app status ${RUN_ID}`), {
    runId: RUN_ID,
    statusCommand: `varitykit app status ${RUN_ID}`,
  });
  assert.deepEqual(lifecycleTracking("varitykit app status not-a-run"), {
    runId: null,
    statusCommand: null,
  });
});

test("acceptance reads public_status and outcome from the run view", async () => {
  const outcome = { classification: "user", code: "build_failed" };
  const stub = stubRunView(200, { public_status: "failed", outcome, status: "failed" });
  try {
    assert.deepEqual(await lifecycleAcceptance({ run_id: RUN_ID, status: "deploying" }), {
      run_id: RUN_ID,
      public_status: "failed",
      outcome,
    });
    assert.equal(stub.calls[0].url, `https://gw.test/api/deployments/runs/${RUN_ID}`);
  } finally {
    stub.restore();
  }
});

test("no run or an unreadable run view is unobserved, never a status", async () => {
  assert.deepEqual(await lifecycleAcceptance({ status: "deploying" }), {
    run_id: null,
    public_status: null,
    outcome: null,
  });
  const stub = stubRunView(502, { code: "deploy_status_unavailable" });
  try {
    assert.deepEqual(await lifecycleAcceptance({ run_id: RUN_ID }), {
      run_id: RUN_ID,
      public_status: null,
      outcome: null,
    });
  } finally {
    stub.restore();
  }
});

test("lifecycle adapters expose the owner's run status or an unproven outcome", async () => {
  const cases = [
    { name: "deploy", invoke: (accepted) => deployAccepted(accepted) },
    { name: "redeploy", invoke: (accepted) => redeployAccepted("demo", accepted) },
    { name: "delete", invoke: (accepted) => deleteAccepted("demo", accepted) },
    {
      name: "template",
      invoke: (accepted) => templateDeployAccepted(
        { id: "demo", name: "Demo" },
        "demo-app",
        accepted.run_id ? `Accepted\nvaritykit app status ${accepted.run_id}` : "Accepted"
      ),
    },
  ];
  for (const scenario of cases) {
    const stub = stubRunView(200, { public_status: "deploying", outcome: null });
    try {
      const tracked = payload(await scenario.invoke({ run_id: RUN_ID }));
      assert.equal(tracked.success, true, scenario.name);
      assert.equal(tracked.data.run_id, RUN_ID, scenario.name);
      assert.equal(tracked.data.public_status, "deploying", scenario.name);
      assert.match(tracked.message, /varity_deploy_status/, scenario.name);
      assert.doesNotMatch(JSON.stringify(tracked), /outcome_unconfirmed/, scenario.name);

      const untracked = payload(await scenario.invoke({}));
      assert.equal(untracked.success, true, scenario.name);
      assert.equal(untracked.data.run_id, null, scenario.name);
      assert.equal(untracked.data.public_status, null, scenario.name);
      assert.match(untracked.message, /not (?:yet )?proven/, scenario.name);
      assert.doesNotMatch(untracked.message, /completed|went live|billing has stopped/i, scenario.name);
    } finally {
      stub.restore();
    }
  }
});

test("delete reports deleted only when the owner says so", async () => {
  const stub = stubRunView(200, { public_status: "deleting" });
  try {
    assert.equal(payload(await deleteAccepted("demo", { run_id: RUN_ID })).data.deleted, false);
    assert.equal(payload(await deleteAccepted("demo", { run_id: null, deleted: true })).data.deleted, true);
  } finally {
    stub.restore();
  }
});

test("default app name matches the CLI's contract-valid slug", () => {
  assert.equal(defaultAppName("https://github.com/Owner/My_App.git"), "my-app");
  assert.equal(defaultAppName("ghcr.io/you/app:latest"), "app");
  assert.equal(defaultAppName("ghcr.io/you/api@sha256:abc"), "api");
});
