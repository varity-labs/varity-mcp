/**
 * `varity_machines_*` are a thin sequence over the gateway machine contract
 * (varity-gateway services/machine-public.ts): create quotes first and sends
 * the quote token with an Idempotency-Key; delete reports billing stopped
 * only when the machine read says so, and an unread state stays unobserved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env["VARITY_GATEWAY_URL"] = "https://gw.test";
process.env["VARITY_API_KEY"] = "api-key";

const { quoteAndCreateMachine, deleteAndConfirmMachine, registerMachinesTools } = await import(
  "../dist/tools/machines.js"
);

const MACHINE_ID = "0b0c7a8e-4d4f-4b6a-9e53-3f1a2b3c4d5e";
const PROFILE = "mp-0123456789abcdef01234567";
const OS_IMAGE = "os-ubuntu-24-04-0123456789ab";

function stubSequence(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const [status, payload] = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const payload = (response) => JSON.parse(response.content[0].text);
const noSleep = async () => {};

test("create quotes, then posts the quote token with an idempotency key", async () => {
  const stub = stubSequence([
    [200, { quote_token: "aq1.token-abcdefgh", hourly_usd: 0.05, authorization_usd: 5, valid_until: "2026-09-25T20:00:00Z" }],
    [202, { replayed: false, machine_id: MACHINE_ID, operation: { status: "accepted" } }],
  ]);
  try {
    const out = payload(await quoteAndCreateMachine({
      name: "dev-box", profile_id: PROFILE, os_image: OS_IMAGE,
      ssh_public_key: "ssh-ed25519 AAAA user@host", idempotency_key: "retry-key-1",
    }));
    assert.equal(stub.calls[0].url, "https://gw.test/api/pricing/machine-quote");
    assert.deepEqual(stub.calls[0].body, { profile_id: PROFILE, execution_class: "cpu_virtual_machine", os_image: OS_IMAGE });
    assert.equal(stub.calls[1].url, "https://gw.test/api/machines");
    assert.equal(stub.calls[1].init.method, "POST");
    assert.equal(stub.calls[1].init.headers["Idempotency-Key"], "retry-key-1");
    assert.deepEqual(stub.calls[1].body, {
      name: "dev-box", profile_id: PROFILE, execution_class: "cpu_virtual_machine", os_image: OS_IMAGE,
      ssh_public_key: "ssh-ed25519 AAAA user@host", accelerator_quote_token: "aq1.token-abcdefgh",
    });
    assert.equal(out.success, true);
    assert.equal(out.data.machine_id, MACHINE_ID);
    assert.equal(out.data.quote.hourly_usd, 0.05);
  } finally {
    stub.restore();
  }
});

test("create without a caller key still sends a contract-valid Idempotency-Key", async () => {
  const stub = stubSequence([
    [200, { quote_token: "aq1.token-abcdefgh" }],
    [202, { replayed: false, machine_id: MACHINE_ID, operation: {} }],
  ]);
  try {
    await quoteAndCreateMachine({ name: "vm", profile_id: PROFILE, os_image: OS_IMAGE, ssh_public_key: "ssh-ed25519 AAAA" });
    assert.match(stub.calls[1].init.headers["Idempotency-Key"], /^[A-Za-z0-9._:-]{8,128}$/);
  } finally {
    stub.restore();
  }
});

test("create input schema refuses a private key before any request", () => {
  const configs = {};
  registerMachinesTools({ registerTool: (name, config) => { configs[name] = config; } });
  assert.deepEqual(Object.keys(configs).sort(), ["varity_machines_create", "varity_machines_delete", "varity_machines_list"]);
  const key = configs.varity_machines_create.inputSchema.ssh_public_key;
  assert.equal(key.safeParse("-----BEGIN OPENSSH PRIVATE KEY-----\nabc").success, false);
  assert.equal(key.safeParse("ssh-ed25519 AAAA user@host").success, true);
});

test("delete polls the machine read until billing.state is stopped, within the operation deadline", async () => {
  const stub = stubSequence([
    [202, { replayed: false, machine_id: MACHINE_ID, operation: { execution_deadline_at: "2999-01-01T00:00:00Z" } }],
    [200, { machine_id: MACHINE_ID, billing: { state: "active" } }],
    [200, { machine_id: MACHINE_ID, billing: { state: "stopped" } }],
  ]);
  try {
    const out = payload(await deleteAndConfirmMachine(MACHINE_ID, "del-key-1", { sleep: noSleep }));
    assert.equal(stub.calls[0].init.method, "DELETE");
    assert.equal(stub.calls[0].url, `https://gw.test/api/machines/${MACHINE_ID}`);
    assert.equal(stub.calls[0].init.headers["Idempotency-Key"], "del-key-1");
    assert.equal(stub.calls.length, 3);
    assert.equal(out.data.billing_state, "stopped");
    assert.equal(out.data.billing_stopped, true);
  } finally {
    stub.restore();
  }
});

test("delete never claims billing stopped when the read is unavailable", async () => {
  const stub = stubSequence([
    [202, { replayed: false, machine_id: MACHINE_ID, operation: {} }],
    [503, { code: "machine_read_unavailable" }],
  ]);
  try {
    const out = payload(await deleteAndConfirmMachine(MACHINE_ID, undefined, { sleep: noSleep }));
    assert.equal(out.data.billing_state, null);
    assert.equal(out.data.billing_stopped, false);
    assert.match(out.message, /not confirmed.*unobserved/);
  } finally {
    stub.restore();
  }
});

test("delete stops polling at the operation's execution_deadline_at and reports unconfirmed", async () => {
  const stub = stubSequence([
    [202, { replayed: false, machine_id: MACHINE_ID, operation: { execution_deadline_at: "2026-09-25T15:10:00Z" } }],
    [200, { machine_id: MACHINE_ID, billing: { state: "active" } }],
  ]);
  let clock = Date.parse("2026-09-25T15:09:50Z");
  const sleep = async (ms) => { clock += ms; };
  try {
    const out = payload(await deleteAndConfirmMachine(MACHINE_ID, undefined, { sleep, now: () => clock }));
    assert.equal(stub.calls.length, 3); // DELETE, read at 15:09:50, read at 15:10:00 (deadline)
    assert.equal(out.data.billing_state, "active");
    assert.equal(out.data.billing_stopped, false);
    assert.match(out.message, /not confirmed/);
  } finally {
    stub.restore();
  }
});
