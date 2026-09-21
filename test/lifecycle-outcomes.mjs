import assert from "node:assert/strict";
import { test } from "node:test";

const { lifecycleTracking } = await import("../dist/utils/cli-bridge.js");
const { lifecycleAcceptance } = await import("../dist/utils/lifecycle-acceptance.js");
const { deployAccepted } = await import("../dist/tools/deploy.js");
const { redeployAccepted } = await import("../dist/tools/redeploy.js");
const { deleteAccepted } = await import("../dist/tools/delete-deployment.js");
const { templateDeployAccepted } = await import("../dist/tools/agent.js");

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

test("one lifecycle projector owns tracked versus unconfirmed status", () => {
  assert.deepEqual(lifecycleAcceptance(`Accepted\nvaritykit app status ${RUN_ID}`, "deploying"), {
    status: "deploying",
    run_id: RUN_ID,
    status_command: `varitykit app status ${RUN_ID}`,
  });
  assert.deepEqual(lifecycleAcceptance("Accepted without tracking", "deploying"), {
    status: "outcome_unconfirmed",
    run_id: null,
    status_command: null,
  });
});

function payload(response) {
  return JSON.parse(response.content[0].text);
}

test("lifecycle acceptance adapters expose exact in-progress and unconfirmed outcomes", () => {
  const trackedOutput = `Accepted\nvaritykit app status ${RUN_ID}`;
  const cases = [
    {
      name: "deploy",
      invoke: (stdout) => deployAccepted(stdout, "https://demo.varity.app/"),
      trackedStatus: "deploying",
    },
    {
      name: "redeploy",
      invoke: (stdout) => redeployAccepted("demo", stdout),
      trackedStatus: "redeploying",
    },
    {
      name: "delete",
      invoke: (stdout) => deleteAccepted("demo", stdout),
      trackedStatus: "deleting",
    },
    {
      name: "template",
      invoke: (stdout) => templateDeployAccepted({ id: "demo", name: "Demo" }, "demo-app", stdout),
      trackedStatus: "deploying",
    },
  ];

  for (const scenario of cases) {
    const tracked = payload(scenario.invoke(trackedOutput));
    assert.equal(tracked.success, true, scenario.name);
    assert.equal(tracked.data.status, scenario.trackedStatus, scenario.name);
    assert.equal(tracked.data.run_id, RUN_ID, scenario.name);
    assert.equal(tracked.data.status_command, `varitykit app status ${RUN_ID}`, scenario.name);
    assert.match(tracked.message, /Track its terminal outcome|Track it with/, scenario.name);

    const untracked = payload(scenario.invoke("Accepted without durable run"));
    assert.equal(untracked.success, true, scenario.name);
    assert.equal(untracked.data.status, "outcome_unconfirmed", scenario.name);
    assert.equal(untracked.data.run_id, null, scenario.name);
    assert.equal(untracked.data.status_command, null, scenario.name);
    assert.match(untracked.message, /not (?:yet )?proven|not proven/, scenario.name);
    assert.doesNotMatch(untracked.message, /completed|went live|billing has stopped/i, scenario.name);
  }

  assert.equal(payload(deleteAccepted("demo", trackedOutput)).data.deleted, false);
  assert.equal(payload(deployAccepted("Accepted without durable run")).data.reported_url, null);
});
