/**
 * R1 M4: deleting a deployment that a deploy key built from a private copy
 * (a hosted repository the key created, `created_by: "deploy_key"`) queues
 * that copy's durable deletion BEFORE the app delete, in the Portal's order
 * (gateway POST /v1/deployment-approvals, then POST
 * /api/github/hosted-repositories/:name/deletion {repository_id} with
 * X-Varity-Approval-Id; the worker removes it once no deployment uses it). A
 * failure to queue never blocks the app delete.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-r1-del-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const ORG = "Varity-Hosted";
const NAME = "u1a2b3c4d5e6f7a8-my-site";
const RUN_ID = "19c9f0b2-5ffa-4391-a096-dd964787f929";
const GET = "GET /api/deployments/my-site";
const LIST = "GET /api/github/hosted-repositories";
const APPROVE = "POST /v1/deployment-approvals";
const QUEUE = `POST /api/github/hosted-repositories/${NAME}/deletion`;
const DELETE = "DELETE /api/deployments/my-site";
const RETRY = 'call varity_delete_deployment again with "my-site" to retry the source cleanup.';

const deployment = (repoUrl) => [200, {
  deployment: { id: "d-1", app_name: "my-site", url: "https://varity.app/my-site/", source: { type: "repository", repository_url: repoUrl } },
}];
const listing = (createdBy) => [200, {
  repositories: [{ id: 42, name: NAME, full_name: `${ORG}/${NAME}`, default_branch: "main", private: true, created_by: createdBy }],
  truncated: false,
}];
const base = {
  [GET]: deployment(`https://github.com/${ORG}/${NAME}`),
  [LIST]: listing("deploy_key"),
  [APPROVE]: [201, { approval_id: "apr_1", expires_at: "2026-11-18T07:00:00Z" }],
  [QUEUE]: [202, { id: "job-1", status: "pending" }],
  [DELETE]: [202, { status: "deleting", run_id: RUN_ID }],
};

async function remove(routes, deploymentArg = "my-site") {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const route = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    calls.push({ route, headers: init.headers, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const [status, body] = routes[route] ?? [404, { code: "not_found", message: "Not found" }];
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
  };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "r1-delete", version: "1" });
  await client.connect(clientSide);
  try {
    const result = await client.callTool({ name: "varity_delete_deployment", arguments: { deployment: deploymentArg } });
    return { isError: Boolean(result.isError), out: JSON.parse(result.content[0].text), calls };
  } finally {
    await client.close();
    globalThis.fetch = original;
  }
}

const routes = (calls) => calls.map((c) => c.route).filter((r) => !r.startsWith("GET /api/deployments/runs/"));

test("a deploy-key private copy is queued for deletion with its exact approval before the app delete", async () => {
  const { isError, out, calls } = await remove(base);
  assert.equal(isError, false);
  assert.deepEqual(routes(calls), [GET, LIST, APPROVE, QUEUE, DELETE]);
  const full = `${ORG}/${NAME}`.toLowerCase();
  assert.deepEqual(calls.find((c) => c.route === APPROVE).body, {
    action: { kind: "delete_hosted_repository", target: `repository:${full}`, fingerprint: `${full}:42` },
  });
  const queued = calls.find((c) => c.route === QUEUE);
  assert.equal(queued.headers["X-Varity-Approval-Id"], "apr_1");
  assert.deepEqual(queued.body, { repository_id: 42 });
  assert.match(out.message, /[Ii]ts private source copy is deleted once the app is gone\./);
  assert.equal(out.data.source_copy, "deletion_queued");
});

test("a Portal-made repository, another repository, or a gateway without the route is never queued; the app is still deleted", async () => {
  for (const variant of [
    { [LIST]: listing("portal") },
    { [GET]: deployment("https://github.com/acme/shop") },
    { [LIST]: [403, { code: "repo_authority_required", message: "Not allowed." }] },
    { [LIST]: [404, { code: "hosted_repositories_unavailable", message: "Off." }] },
  ]) {
    const { isError, out, calls } = await remove({ ...base, ...variant });
    assert.equal(isError, false, JSON.stringify(variant));
    assert.ok(!routes(calls).includes(APPROVE) && !routes(calls).includes(QUEUE), JSON.stringify(variant));
    assert.ok(routes(calls).includes(DELETE));
    assert.doesNotMatch(out.message, /source copy|source cleanup/);
  }
});

test("a failure to queue the copy's deletion never blocks the app delete, and the text ends with the retry action", async () => {
  for (const variant of [
    { [QUEUE]: [503, { code: "repository_usage_unavailable", message: "Try again." }] },
    { [APPROVE]: [503, { code: "approvals_unavailable", message: "Try again." }] },
    { [LIST]: [503, { code: "github_unavailable", message: "Try again." }] },
  ]) {
    const { isError, out, calls } = await remove({ ...base, ...variant });
    assert.equal(isError, false, JSON.stringify(variant));
    assert.ok(routes(calls).includes(DELETE));
    assert.ok(out.message.endsWith(RETRY), out.message);
    assert.equal(out.data.source_copy, "not_queued");
  }
});

// ST-1: the gateway names a hosted copy `<16 hex owner prefix>-<slug>` (github-authority.ts
// HOSTED_REPO_NAME), and varity_deploy uses the app name as the slug.
const HEX_NAME = "1a2b3c4d5e6f7a8b-my-site";
const hexListing = (repos) => [200, { repositories: repos, truncated: false }];
const hexRepo = (name, createdBy = "deploy_key", id = 77) => ({ id, name, full_name: `${ORG}/${name}`, default_branch: "main", private: true, created_by: createdBy });
const HEX_QUEUE = `POST /api/github/hosted-repositories/${HEX_NAME}/deletion`;

test("ST-1: a retry after the app is already gone still queues its private copy by app name, and says so", async () => {
  const { isError, out, calls } = await remove({
    [GET]: [404, { code: "deployment_not_found", message: "Deployment not found." }],
    [LIST]: hexListing([hexRepo(HEX_NAME), hexRepo("1a2b3c4d5e6f7a8b-my-site-old", "deploy_key", 78), hexRepo("1a2b3c4d5e6f7a8b-shop", "deploy_key", 79)]),
    [APPROVE]: [201, { approval_id: "apr_2", expires_at: "2026-11-18T07:00:00Z" }],
    [HEX_QUEUE]: [202, { id: "job-2", status: "pending" }],
    [DELETE]: [404, { code: "deployment_not_found", message: "Deployment not found." }],
  });
  assert.equal(isError, false, JSON.stringify(out));
  assert.deepEqual(routes(calls), [GET, LIST, APPROVE, HEX_QUEUE, DELETE]);
  const full = `${ORG}/${HEX_NAME}`.toLowerCase();
  assert.deepEqual(calls.find((c) => c.route === APPROVE).body, {
    action: { kind: "delete_hosted_repository", target: `repository:${full}`, fingerprint: `${full}:77` },
  });
  assert.deepEqual(calls.find((c) => c.route === HEX_QUEUE).body, { repository_id: 77 });
  assert.equal(out.data.source_copy, "deletion_queued");
  assert.match(out.message, /No deployment "my-site" is left to delete\. Its private source copy is queued for deletion and is removed once no deployment uses it\./);
});

test("ST-1: the name fallback never touches a Portal-made copy, another app's copy, or a copy looked up by deployment id", async () => {
  const gone = [404, { code: "deployment_not_found", message: "Deployment not found." }];
  for (const [listed, arg] of [
    [[hexRepo(HEX_NAME, "portal")], "my-site"],
    [[hexRepo("1a2b3c4d5e6f7a8b-my-site-old")], "my-site"],
    [[hexRepo(HEX_NAME)], "0e9c1d2a-1111-4222-8333-944455556666"],
  ]) {
    const { calls } = await remove({
      [GET]: gone,
      [`GET /api/deployments/${arg}`]: gone,
      [LIST]: hexListing(listed),
      [APPROVE]: [201, { approval_id: "apr_3" }],
      [`DELETE /api/deployments/${arg}`]: gone,
    }, arg);
    assert.ok(!routes(calls).includes(APPROVE), JSON.stringify(listed));
  }
});

test("ST-2: when the app delete is refused after the copy was queued, the error says the copy is already queued", async () => {
  const { isError, out } = await remove({
    ...base,
    [DELETE]: [409, { code: "deployment_delete_rejected", message: "The delete was refused.", action: "Retry the request." }],
  });
  assert.equal(isError, true);
  assert.equal(out.error.code, "deployment_delete_rejected");
  assert.match(out.error.message, /^The delete was refused\. Its private source copy is already queued for deletion and is removed once no deployment uses it\.$/);
});

test("SP-7: the delete tool and README say the private copy is deleted too", async () => {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "r1-delete-desc", version: "1" });
  await client.connect(clientSide);
  const tool = (await client.listTools()).tools.find((t) => t.name === "varity_delete_deployment");
  await client.close();
  const line = "If Varity saved a private copy of a folder for this app, that copy is deleted too.";
  assert.ok(tool.description.includes(line), tool.description);
  const { readFileSync } = await import("node:fs");
  const row = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n").find((l) => l.startsWith("| `varity_delete_deployment`"));
  assert.ok(row.includes(line), row);
});
