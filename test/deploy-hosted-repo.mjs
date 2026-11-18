/**
 * R1 M2-M5 (PLAN-R1 §2 with VERIFY-R1 E5-E7, E9, E10, E12): when the upload
 * route is unavailable, a local folder is saved as a private copy Varity
 * keeps (a hosted repository) and deployed from its exact commit.
 *
 * The gateway is a fetch stub speaking the gateway contract (varity-platform
 * services/varity-gateway): POST /api/github/hosted-repositories {name} ->
 * 201 {repository}; 404 hosted_repositories_unavailable when the flag is off;
 * 403 repo_authority_required on a gateway that refuses keys; POST
 * /api/github/changes (Idempotency-Key) -> 201 {branch, commit_sha, base_sha};
 * 429/503 with Retry-After; 504 github_deadline_exceeded with or without a
 * landed write; then POST /api/deployments {repo_url, commit}.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_DEPLOY_KEY = "deploy-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "varity-r1-"));
delete process.env.VARITY_API_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const CHAT_AND_BUILD = "https://developer.store.varity.so/dashboard/ai-gateway?tab=chat&mode=build";
const SOURCES = "POST /api/deployments/sources";
const HOSTED = "POST /api/github/hosted-repositories";
const CHANGES = "POST /api/github/changes";
const CREATE = "POST /api/deployments";
const RUN_ID = "19c9f0b2-5ffa-4391-a096-dd964787f929";
const ORG = "varity-hosted";
const PREFIX = "u1a2b3c4d5e6f7a8";
const UPLOAD_OFF = [404, { code: "uploads_unavailable", message: "Deploying uploaded files is not available yet." }];
const repoFor = (name) => [201, {
  repository: { id: 42, owner: ORG, name: `${PREFIX}-${name}`, full_name: `${ORG}/${PREFIX}-${name}`, default_branch: "main", private: true },
}];
const sha = (i) => i.toString(16).padStart(40, "0");
const ACCEPTED = [202, { id: "d-1", app_name: "my-site", status: "deploying", run_id: RUN_ID }];
const SAVE_ACTION =
  "Add large media, data or build folders to .gitignore and call varity_deploy again with the same path; or put it on Varity another way: " +
  `describe the app in Varity's Chat and Build (${CHAT_AND_BUILD}), deploy a ready-made template (varity_list_templates), ` +
  "or deploy a prebuilt container image (image argument).";
// A PNG header: NUL bytes, not UTF-8.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe]);

/**
 * `METHOD path` -> a function of the call, or a queue of [status, body, headers]
 * (the last one repeats); anything else 404 not_found. A response of "throw"
 * is a network failure. `CHANGES` defaults to 201 with commit i+1.
 */
function stubGateway(routes, { clock } = {}) {
  const calls = [];
  const used = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const route = `${init.method} ${parsed.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { route, headers: init.headers, body, index: used[route] ?? 0 };
    calls.push(call);
    used[route] = call.index + 1;
    clock?.(call);
    let answer = routes[route];
    if (typeof answer === "function") answer = answer(call, calls);
    else if (Array.isArray(answer)) answer = answer[Math.min(call.index, answer.length - 1)];
    // PLAN-W2: a deploy first looks the app up; the producer's own not-found (gateway public-api.ts:1645-1650 at 98042b77) is a first deploy.
    if (answer === undefined && /^GET \/api\/deployments\/(?!runs\/)[^/]+$/.test(route)) {
      answer = [404, { code: "deployment_not_found", message: "Deployment not found.", action: "Check the deployment id and API key owner.", retryable: false }];
    }
    if (answer === undefined && route === CHANGES) answer = [201, { branch: body.branch, commit_sha: sha(calls.filter((c) => c.route === CHANGES).length), base_sha: sha(999) }];
    if (answer === "throw") throw new TypeError("fetch failed");
    const [status, payload, headers = {}] = answer ?? [404, { code: "not_found", message: "Not found" }];
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => lower[k.toLowerCase()] ?? null }, json: async () => payload };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function connect() {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "r1-test", version: "1" });
  await client.connect(clientSide);
  return client;
}

/**
 * SP-5: the private copy is the path once this server saw the upload route answer off; until then a
 * folder the upload cannot pack (the highly compressible fixtures below) gets the upload's refusal. So
 * the cap and chunk cases run on a server that already saw the route off.
 */
async function uploadOffClient() {
  const client = await connect();
  const { dir, cleanup } = project();
  try {
    const stub = stubGateway({ [SOURCES]: [UPLOAD_OFF] });
    try {
      await client.callTool({ name: "varity_deploy", arguments: { path: dir } });
    } finally {
      stub.restore();
    }
  } finally {
    cleanup();
  }
  return client;
}

async function deploy(args, routes, { client: shared, clock, uploadOff } = {}) {
  const client = shared ?? (uploadOff ? await uploadOffClient() : await connect());
  const stub = stubGateway(routes, { clock });
  try {
    const result = await client.callTool({ name: "varity_deploy", arguments: args });
    return { isError: Boolean(result.isError), out: JSON.parse(result.content[0].text), calls: stub.calls };
  } finally {
    stub.restore();
    if (!shared) await client.close();
  }
}

/** A project folder: `files` maps relative path -> string | Buffer. */
function project(files = { "index.html": "<h1>Flour Lane</h1>\n" }) {
  const root = mkdtempSync(join(tmpdir(), "mcp-r1-"));
  const dir = join(root, "my-site");
  mkdirSync(dir);
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const of = (calls, route) => calls.filter((c) => c.route === route);
const many = (n, make) => Object.fromEntries(Array.from({ length: n }, (_, i) => make(i)));
const base = { [SOURCES]: [UPLOAD_OFF], [HOSTED]: [repoFor("my-site")], [CREATE]: [ACCEPTED] };

test("a folder is saved as a private copy (utf-8 and base64, secrets kept local) and deployed from its exact commit", async () => {
  const { dir, cleanup } = project({
    "index.html": "<h1>Flour Lane</h1>\n",
    "src/main.js": "console.log('héllo')\n",
    "logo.png": PNG,
    ".env": "STRIPE_KEY=sk_live_DO_NOT_LEAK\n",
    ".gitignore": "logs/\n",
    "logs/a.log": "noise\n",
  });
  try {
    const { isError, out, calls } = await deploy({ path: dir }, base);
    assert.equal(isError, false, JSON.stringify(out));
    // Upload is tried first; it answered off, so the hosted path ran.
    assert.deepEqual(calls.map((c) => c.route), [SOURCES, "GET /api/deployments/my-site", HOSTED, CHANGES, CREATE, "GET /api/deployments/runs/" + RUN_ID]);
    assert.deepEqual(of(calls, HOSTED)[0].body, { name: "my-site" });
    const [change] = of(calls, CHANGES);
    assert.deepEqual(change.body.repo, { owner: ORG, name: `${PREFIX}-my-site` });
    assert.equal(change.body.base_ref, "main");
    assert.match(change.body.branch, /^varity\/mcp-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    assert.equal(change.body.expected_head_sha, undefined);
    assert.equal(change.body.open_pr, false);
    assert.match(change.headers["Idempotency-Key"], /^mcp-change:[0-9a-f-]{36}:0$/);
    const files = Object.fromEntries(change.body.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(files).sort(), [".gitignore", "index.html", "logo.png", "src/main.js"]);
    assert.deepEqual(files["src/main.js"], { path: "src/main.js", content: "console.log('héllo')\n", encoding: "utf-8" });
    assert.equal(files["logo.png"].encoding, "base64");
    assert.deepEqual(Buffer.from(files["logo.png"].content, "base64"), PNG);
    assert.ok(!JSON.stringify(calls.map((c) => c.body)).includes("DO_NOT_LEAK"));
    assert.deepEqual(of(calls, CREATE)[0].body, {
      app_name: "my-site", repo_url: `https://github.com/${ORG}/${PREFIX}-my-site`, commit: sha(1), source: "mcp",
    });
    assert.equal(out.data.source, "varity_private_repository");
    assert.equal(out.data.id, "d-1");
    assert.match(out.message, /^This project has no GitHub repository, so Varity saved a private copy of this folder \(4 files; left out 1 ignored; kept secret files \.env on this computer\) and is building it\. /);
    assert.match(out.message, /varity_deploy_status/);
  } finally {
    cleanup();
  }
});

test("E12: redeploying the same folder reuses the repository by name, adds a new branch and updates the same app; upload is not retried once off", async () => {
  const { dir, cleanup } = project();
  const client = await connect();
  try {
    const first = await deploy({ path: dir, app_name: "my-site" }, base, { client });
    const second = await deploy({ path: dir, app_name: "my-site" }, base, { client });
    assert.equal(second.isError, false);
    assert.equal(of(second.calls, SOURCES).length, 0, "the upload route already answered off on this server");
    assert.deepEqual(of(second.calls, HOSTED)[0].body, of(first.calls, HOSTED)[0].body);
    assert.notEqual(of(second.calls, CHANGES)[0].body.branch, of(first.calls, CHANGES)[0].body.branch);
    assert.equal(of(second.calls, CREATE)[0].body.app_name, "my-site");
  } finally {
    await client.close();
    cleanup();
  }
});

/** The gateway's served same-name create (201 {repository}), captured from the producer at 0c46f756 (CHANGE-IMPACT :36). */
const SAME_NAME = JSON.parse(readFileSync(new URL("./fixtures/gateway-0c46f756-hosted-create-same-name.json", import.meta.url), "utf8"));

test("GW-SP-2: a same-name redeploy receives the existing key-made repository (201, same id, its live default branch) and commits on a new varity/ branch from that branch, then updates the same app", async () => {
  const { repository } = SAME_NAME.body;
  for (const [defaultBranch, baseRef] of [[repository.default_branch, repository.default_branch], [null, "main"]]) {
    const served = [SAME_NAME.status, { repository: { ...repository, default_branch: defaultBranch } }];
    const routes = { ...base, [HOSTED]: [served] };
    const { dir, cleanup } = project();
    const client = await connect();
    try {
      const first = await deploy({ path: dir, app_name: "site" }, routes, { client });
      const second = await deploy({ path: dir, app_name: "site" }, routes, { client });
      for (const run of [first, second]) {
        assert.equal(run.isError, false, JSON.stringify(run.out));
        assert.deepEqual(of(run.calls, HOSTED)[0].body, { name: "site" });
        const [change] = of(run.calls, CHANGES);
        assert.equal(change.body.base_ref, baseRef, String(defaultBranch));
        assert.equal(change.body.expected_head_sha, undefined);
        assert.match(change.body.branch, /^varity\/mcp-/);
        const create = of(run.calls, CREATE)[0].body;
        assert.equal(create.repo_url, `https://github.com/${repository.full_name}`);
        assert.equal(create.app_name, "site");
        assert.doesNotMatch(run.out.message, /created/i);
      }
      assert.notEqual(of(second.calls, CHANGES)[0].body.branch, of(first.calls, CHANGES)[0].body.branch);
    } finally {
      await client.close();
      cleanup();
    }
  }
});

test("chunks: at most 50 files, 1,000,000 bytes and 20 base64 files per commit; later commits append to the same branch fenced on the last head, each with its own key", async () => {
  const cases = [
    ["files", many(120, (i) => [`f${String(i).padStart(3, "0")}.txt`, `${i}\n`]), [50, 50, 20]],
    ["bytes", many(3, (i) => [`big${i}.txt`, "a".repeat(400_000)]), [2, 1]],
    ["base64", many(25, (i) => [`img${String(i).padStart(2, "0")}.png`, PNG]), [20, 5]],
  ];
  for (const [name, files, sizes] of cases) {
    const { dir, cleanup } = project(files);
    try {
      const { isError, out, calls } = await deploy({ path: dir }, base, { uploadOff: true });
      assert.equal(isError, false, `${name}: ${JSON.stringify(out)}`);
      const changes = of(calls, CHANGES);
      assert.deepEqual(changes.map((c) => c.body.files.length), sizes, name);
      const run = changes[0].headers["Idempotency-Key"].split(":")[1];
      changes.forEach((c, i) => {
        assert.equal(c.headers["Idempotency-Key"], `mcp-change:${run}:${i}`, name);
        assert.equal(c.body.branch, changes[0].body.branch, name);
        assert.equal(c.body.expected_head_sha, i === 0 ? undefined : sha(i), name);
      });
      assert.equal(of(calls, CREATE)[0].body.commit, sha(changes.length), name);
    } finally {
      cleanup();
    }
  }
});

test("caps and the paced unit budget refuse before any hosted call: 500 files, 5 MB, 1,000,000 bytes per file, more than 3 minute windows of 23 units", async () => {
  const cases = [
    ["files", many(501, (i) => [`f${i}.txt`, "x"])],
    ["file", { "video.bin": Buffer.alloc(1_000_001, 1) }],
    ["total", many(6, (i) => [`part${i}.txt`, "b".repeat(900_000)])],
    // 60 base64 files need 3 commits: 2 + 3 x 23 = 71 units, packed [2] [23] [23] [23] = 4 windows.
    ["units", many(60, (i) => [`img${i}.png`, PNG])],
    // 45 base64 files: 2 + 23 + 23 + 8 = 56 units, under 69 but packed in send order into 4 windows.
    ["packing", many(45, (i) => [`img${i}.png`, PNG])],
  ];
  for (const [name, files] of cases) {
    const { dir, cleanup } = project(files);
    try {
      const { isError, out, calls } = await deploy({ path: dir }, base, { uploadOff: true });
      assert.equal(isError, true, name);
      assert.equal(out.error.code, "FOLDER_TOO_LARGE_FOR_VARITY", name);
      assert.equal(out.error.suggestion, SAVE_ACTION, name);
      assert.match(out.error.message, /Nothing was deployed or charged\./, name);
      assert.deepEqual(calls.map((c) => c.route).filter((r) => r !== SOURCES), [], name);
    } finally {
      cleanup();
    }
  }
  // 40 base64 files fit: [2] [23] [23] = 3 windows.
  const { dir, cleanup } = project(many(40, (i) => [`img${i}.png`, PNG]));
  try {
    assert.equal((await deploy({ path: dir }, base, { uploadOff: true })).isError, false);
  } finally {
    cleanup();
  }
});

test("E10: route unavailable (404 flag off, 403 repo_authority_required) creates nothing and returns the existing Chat and Build copy; 409 name in use asks for another app_name", async () => {
  for (const answer of [
    [404, { code: "hosted_repositories_unavailable", message: "Hosted repositories are not available." }],
    [404, { code: "not_found", message: "Not found" }],
    [403, { code: "repo_authority_required", message: "Not allowed." }],
  ]) {
    const { dir, cleanup } = project();
    try {
      const { isError, out, calls } = await deploy({ path: dir }, { ...base, [HOSTED]: [answer] });
      assert.equal(isError, true);
      assert.equal(out.error.code, "UPLOAD_UNAVAILABLE", answer[1].code);
      assert.ok(out.error.message.includes(CHAT_AND_BUILD), out.error.message);
      assert.equal(of(calls, CHANGES).length + of(calls, CREATE).length, 0);
    } finally {
      cleanup();
    }
  }
  const { dir, cleanup } = project();
  try {
    const { isError, out, calls } = await deploy({ path: dir }, {
      ...base,
      [HOSTED]: [[409, { code: "hosted_repository_name_in_use", message: "A Varity project you made in the Developer Portal already uses this name." }]],
    });
    assert.equal(isError, true);
    assert.equal(out.error.code, "hosted_repository_name_in_use");
    assert.equal(out.error.suggestion, "Call varity_deploy again with a different app_name.");
    assert.equal(of(calls, CHANGES).length, 0);
  } finally {
    cleanup();
  }
});

test("429 and 503 return the served Retry-After as a Varity action; nothing is deployed", async () => {
  const cases = [
    // A 429 whose wait cannot fit the 170 s commit deadline is not paced (the owner-hour shape).
    [{ [CHANGES]: [[429, { code: "rate_limited", message: "Too many saves." }, { "Retry-After": "3600" }]] }, "rate_limited", 3600],
    [{ [HOSTED]: [[503, { code: "hosted_capacity_exhausted", message: "Varity is busy." }, { "Retry-After": "120" }]] }, "hosted_capacity_exhausted", 120],
    [{ [HOSTED]: [[429, { code: "hosted_capacity_exhausted", message: "Varity is busy.", retryable: true }, { "retry-after": "3600" }]] }, "hosted_capacity_exhausted", 3600],
  ];
  for (const [routes, code, seconds] of cases) {
    const { dir, cleanup } = project();
    try {
      const { isError, out, calls } = await deploy({ path: dir }, { ...base, ...routes });
      assert.equal(isError, true, code);
      assert.equal(out.error.code, code);
      assert.equal(out.error.suggestion, `Call varity_deploy again with the same path after ${seconds} seconds.`);
      assert.match(out.error.message, /Nothing was deployed or charged\./);
      assert.equal(of(calls, CREATE).length, 0);
    } finally {
      cleanup();
    }
  }
});

test("E9: no commit starts after 170 s and no deploy starts after 200 s; both answer FOLDER_SAVE_INCOMPLETE", async () => {
  const realNow = Date.now;
  const t0 = realNow();
  let offset = 0;
  Date.now = () => t0 + offset;
  try {
    // After the first commit lands the clock passes 170 s: the second commit is never sent.
    let project1 = project(many(60, (i) => [`f${i}.txt`, "x"]));
    try {
      const { isError, out, calls } = await deploy({ path: project1.dir }, base, {
        clock: (call) => { if (call.route === CHANGES) offset = 171_000; },
      });
      assert.equal(isError, true);
      assert.equal(out.error.code, "FOLDER_SAVE_INCOMPLETE");
      assert.match(out.error.message, /nothing was deployed or charged/i);
      assert.equal(out.error.suggestion, "Call varity_deploy again with the same path.");
      assert.equal(of(calls, CHANGES).length, 1);
      assert.equal(of(calls, CREATE).length, 0);
    } finally {
      project1.cleanup();
    }
    offset = 0;
    // One commit, but it returns after 200 s: the deploy is never started.
    project1 = project();
    try {
      const { out, calls } = await deploy({ path: project1.dir }, base, {
        clock: (call) => { if (call.route === CHANGES) offset = 201_000; },
      });
      assert.equal(out.error.code, "FOLDER_SAVE_INCOMPLETE");
      assert.equal(of(calls, CREATE).length, 0);
    } finally {
      project1.cleanup();
    }
  } finally {
    Date.now = realNow;
  }
});

test("E9: one resend with the same key on a network error or a 504 that landed nothing; a partial write stops without a resend", async () => {
  const unlanded = [504, { code: "github_deadline_exceeded", message: "The request ran out of time before GitHub answered; no write was started after the deadline." }];
  // ST-3: the resend is decided by the served code, never by its prose. The gateway's only
  // landed 504 is the pull-request step, which open_pr:false never reaches; any other 504 stops.
  const otherTimeout = [504, { code: "gateway_timeout", message: "The upstream timed out." }];
  for (const first of ["throw", unlanded]) {
    const { dir, cleanup } = project();
    try {
      const { isError, calls } = await deploy({ path: dir }, {
        ...base,
        [CHANGES]: (call) => (call.index === 0 ? first : [201, { branch: call.body.branch, commit_sha: sha(7), base_sha: sha(9) }]),
      });
      assert.equal(isError, false);
      const changes = of(calls, CHANGES);
      assert.equal(changes.length, 2);
      assert.equal(changes[1].headers["Idempotency-Key"], changes[0].headers["Idempotency-Key"]);
      assert.deepEqual(changes[1].body, changes[0].body);
      assert.equal(of(calls, CREATE)[0].body.commit, sha(7));
    } finally {
      cleanup();
    }
  }
  for (const answers of [
    [otherTimeout],
    ["throw", otherTimeout],
    [unlanded, [409, { code: "branch_exists", message: "The branch already exists." }]],
    [unlanded, [409, { code: "head_moved", message: "The branch moved." }]],
    [unlanded, unlanded],
  ]) {
    const { dir, cleanup } = project();
    try {
      const { out, calls } = await deploy({ path: dir }, { ...base, [CHANGES]: answers });
      assert.equal(out.error.code, "FOLDER_SAVE_INCOMPLETE", JSON.stringify(answers));
      assert.equal(out.error.suggestion, "Call varity_deploy again with the same path.");
      assert.equal(of(calls, CHANGES).length, answers.length);
      assert.equal(of(calls, CREATE).length, 0);
    } finally {
      cleanup();
    }
  }
});

test("SP-3: a 429 or 503 on the final create returns the served Retry-After as a Varity action", async () => {
  for (const [status, seconds] of [[429, 45], [503, 90]]) {
    const { dir, cleanup } = project();
    try {
      const { isError, out, calls } = await deploy({ path: dir }, {
        ...base,
        [CREATE]: [[status, { code: "deploy_capacity", message: "Varity is busy." }, { "Retry-After": String(seconds) }]],
      });
      assert.equal(isError, true, String(status));
      assert.equal(out.error.code, "deploy_capacity");
      assert.equal(out.error.suggestion, `Call varity_deploy again with the same path after ${seconds} seconds.`);
      assert.match(out.error.message, /^Varity saved this folder, but the deploy was not started: Varity is busy\./);
      assert.equal(of(calls, CREATE).length, 1);
    } finally {
      cleanup();
    }
  }
});

test("SPN-2: a create whose start is unconfirmed (unreachable, or acceptance unconfirmed) says so and points at varity_deploy_status", async () => {
  const unconfirmed = [504, { code: "deploy_acceptance_unconfirmed", message: "Varity could not confirm the deploy was accepted." }];
  for (const answer of ["throw", unconfirmed]) {
    const { dir, cleanup } = project();
    try {
      const { isError, out } = await deploy({ path: dir }, { ...base, [CREATE]: [answer] });
      assert.equal(isError, true);
      assert.equal(out.error.message, "Varity saved this folder; whether the deploy started is unconfirmed.", JSON.stringify(answer));
      assert.equal(out.error.suggestion, 'Check varity_deploy_status with "my-site" before deploying again.');
      assert.doesNotMatch(JSON.stringify(out), /not started/);
    } finally {
      cleanup();
    }
  }
});

test("SP-6: a folder over the unit budget is refused in neutral words, not blamed on binary files", async () => {
  // 471 text files and 29 images: commits of 20 images, 9 images + 41 pages, then 9 of pages, so
  // [2] [23] [12 3 3 3] [3 x 6] = 4 windows. The 29 images alone are not the cause; the number of saves is.
  const { dir, cleanup } = project({
    ...many(471, (i) => [`page${String(i).padStart(3, "0")}.txt`, `${i}\n`]),
    ...many(29, (i) => [`img${String(i).padStart(2, "0")}.png`, PNG]),
  });
  try {
    const { isError, out, calls } = await deploy({ path: dir }, base, { uploadOff: true });
    assert.equal(isError, true);
    assert.equal(out.error.code, "FOLDER_TOO_LARGE_FOR_VARITY");
    assert.match(out.error.message, /^This folder needs more saves than one folder deploy allows\. Nothing was deployed or charged\.$/);
    assert.doesNotMatch(out.error.message, /binary/);
    assert.deepEqual(calls.map((c) => c.route).filter((r) => r !== SOURCES), []);
  } finally {
    cleanup();
  }
});

/** SP-4: every request's own timeout, read at the moment it is sent. */
async function withTimeouts(run) {
  const realSetTimeout = globalThis.setTimeout;
  let last;
  globalThis.setTimeout = (fn, ms, ...rest) => { last = ms; return realSetTimeout(fn, ms, ...rest); };
  try {
    return await run(() => last);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test("SP-4: hard deadline: no request runs past 230 s, so the whole call ends inside claude.ai's 240 s", async () => {
  const realNow = Date.now;
  const t0 = realNow();
  let offset = 0;
  Date.now = () => t0 + offset;
  try {
    // A commit that failed at 200 s is resent with only the 30 s left.
    let p = project();
    try {
      const { isError, calls } = await withTimeouts((timeout) => deploy({ path: p.dir }, {
        ...base,
        [CHANGES]: (call) => (call.index === 0 ? "throw" : [201, { branch: call.body.branch, commit_sha: sha(7), base_sha: sha(9) }]),
      }, {
        clock: (call) => {
          call.timeout = timeout();
          if (call.route === CHANGES && call.index === 0) offset = 200_000;
          if (call.route === CHANGES && call.index === 1) offset = 0;
        },
      }));
      assert.equal(isError, false);
      assert.equal(of(calls, CHANGES)[0].timeout, 60_000);
      assert.equal(of(calls, CHANGES)[1].timeout, 30_000);
    } finally {
      p.cleanup();
    }
    // A commit that failed after 230 s is not resent at all.
    offset = 0;
    p = project();
    try {
      const { out, calls } = await deploy({ path: p.dir }, { ...base, [CHANGES]: ["throw"] }, {
        clock: (call) => { if (call.route === CHANGES) offset = 231_000; },
      });
      assert.equal(out.error.code, "FOLDER_SAVE_INCOMPLETE");
      assert.equal(of(calls, CHANGES).length, 1);
      assert.equal(of(calls, CREATE).length, 0);
    } finally {
      p.cleanup();
    }
    // The deploy started at 199 s gets 31 s, not the 60 s default.
    offset = 0;
    p = project();
    try {
      const { isError, calls } = await withTimeouts((timeout) => deploy({ path: p.dir }, base, {
        clock: (call) => {
          call.timeout = timeout();
          if (call.route === CHANGES) offset = 199_000;
        },
      }));
      assert.equal(isError, false);
      assert.equal(of(calls, CREATE)[0].timeout, 31_000);
    } finally {
      p.cleanup();
    }
  } finally {
    Date.now = realNow;
  }
});

test("422 secret_path_refused names the file and ends with a Varity action", async () => {
  const { dir, cleanup } = project({ "index.html": "<h1>x</h1>\n", "deploy/creds.cfg": "x\n" });
  try {
    const { out } = await deploy({ path: dir }, {
      ...base,
      [CHANGES]: [[422, { code: "secret_path_refused", message: "That file looks like a secret.", field: "files[0].path" }]],
    });
    assert.equal(out.error.code, "secret_path_refused");
    assert.match(out.error.message, /deploy\/creds\.cfg/);
    assert.equal(out.error.suggestion, "Move it out of the project folder or add it to .gitignore, set its values with varity_set_env, then call varity_deploy again with the same path.");
  } finally {
    cleanup();
  }
});

test("M5: varity_deploy says precisely what happens to a folder without a readable GitHub repository", async () => {
  const client = await connect();
  const tool = (await client.listTools()).tools.find((t) => t.name === "varity_deploy");
  await client.close();
  const rule = "a folder without a readable GitHub repository is saved as a private copy Varity keeps (deleted with the deployment) and built";
  assert.ok(tool.description.includes(rule.replace(/^a/, "A")), tool.description);
  assert.ok(tool.inputSchema.properties.path.description.includes(rule), tool.inputSchema.properties.path.description);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
});

test("STN-7: the folder rule's clause and sentence say the same thing", async () => {
  const { FOLDER_RULE, FOLDER_RULE_SENTENCE } = await import("../dist/tools/deploy-copy.js");
  assert.equal(typeof FOLDER_RULE, "string");
  assert.equal(FOLDER_RULE_SENTENCE, FOLDER_RULE[0].toUpperCase() + FOLDER_RULE.slice(1));
});

/**
 * #1099 (PLAN-2.3.30 §2.11): a fake gateway ledger of 23 key units per minute (`org_keys:minute`).
 * A create costs 2, a commit 3 + its base64 files. A request over the window answers 429 with
 * Retry-After = seconds to the window's end, as the gateway's reserve does. The clock is fake:
 * `Date.now` reads `t0 + offset` and the pacing seam advances `offset` instead of waiting.
 */
async function withPacedClock(run) {
  const { pacing } = await import("../dist/tools/deploy-private-copy.js");
  const realNow = Date.now;
  const realSleep = pacing.sleep;
  const t0 = realNow();
  const clock = { offset: 0, slept: [] };
  Date.now = () => t0 + clock.offset;
  pacing.sleep = async (ms) => { clock.slept.push(ms); clock.offset += ms; };
  try {
    return await run(clock);
  } finally {
    Date.now = realNow;
    pacing.sleep = realSleep;
  }
}

function minuteLedger(clock, perMinute = 23) {
  const used = new Map();
  let landed = 0;
  const reserve = (units) => {
    const window = Math.floor(clock.offset / 60_000);
    const total = (used.get(window) ?? 0) + units;
    if (total > perMinute) {
      const retryAfter = Math.ceil((60_000 - (clock.offset % 60_000)) / 1000);
      return [429, { code: "hosted_capacity_exhausted", message: "Varity is busy." }, { "Retry-After": String(retryAfter) }];
    }
    used.set(window, total);
    return null;
  };
  return {
    [HOSTED]: () => reserve(2) ?? repoFor("my-site"),
    [CHANGES]: (call) => {
      const units = 3 + call.body.files.filter((f) => f.encoding === "base64").length;
      return reserve(units) ?? [201, { branch: call.body.branch, commit_sha: sha(100 + (landed += 1)), base_sha: sha(999) }];
    },
  };
}

test("#1099 pacing: a 40-unit folder against a 23-per-minute stub completes in one run with no duplicate commit", async () => {
  await withPacedClock(async (clock) => {
    // 32 images: commits of 20 and 12 base64 files; units 2 + 23 + 15 = 40.
    const { dir, cleanup } = project(many(32, (i) => [`img${String(i).padStart(2, "0")}.png`, PNG]));
    try {
      const { isError, out, calls } = await deploy({ path: dir }, { ...base, ...minuteLedger(clock) }, { uploadOff: true });
      assert.equal(isError, false, JSON.stringify(out));
      assert.equal(of(calls, HOSTED).length, 1);
      const changes = of(calls, CHANGES);
      const keys = [...new Set(changes.map((c) => c.headers["Idempotency-Key"]))];
      assert.equal(keys.length, 2, "two commits, each with its own key");
      for (const key of keys) {
        const sent = changes.filter((c) => c.headers["Idempotency-Key"] === key);
        for (const resend of sent.slice(1)) assert.deepEqual(resend.body, sent[0].body, "a paced resend is the same request");
      }
      const last = (key) => changes.filter((c) => c.headers["Idempotency-Key"] === key).at(-1);
      assert.equal(last(keys[0]).body.branch, last(keys[1]).body.branch);
      assert.equal(last(keys[0]).body.expected_head_sha, undefined);
      assert.equal(last(keys[1]).body.expected_head_sha, sha(101));
      assert.equal(of(calls, CREATE).length, 1);
      assert.equal(of(calls, CREATE)[0].body.commit, sha(102));
      assert.ok(clock.offset < 170_000, `${clock.offset} ms`);
    } finally {
      cleanup();
    }
  });
});

test("#1099 pacing: a deadline hit mid-pacing answers FOLDER_SAVE_INCOMPLETE and creates no second repository", async () => {
  await withPacedClock(async (clock) => {
    const { dir, cleanup } = project(many(60, (i) => [`f${String(i).padStart(2, "0")}.txt`, `${i}\n`]));
    try {
      const { isError, out, calls } = await deploy({ path: dir }, {
        ...base,
        [CHANGES]: (call) => {
          if (call.index === 0) {
            clock.offset = 150_000;
            return [201, { branch: call.body.branch, commit_sha: sha(1), base_sha: sha(999) }];
          }
          clock.offset = 151_000;
          return [429, { code: "hosted_capacity_exhausted", message: "Varity is busy." }, { "Retry-After": "30" }];
        },
      }, { uploadOff: true });
      assert.equal(isError, true);
      assert.equal(out.error.code, "FOLDER_SAVE_INCOMPLETE", JSON.stringify(out));
      assert.equal(of(calls, HOSTED).length, 1);
      assert.equal(of(calls, CHANGES).length, 2);
      assert.equal(of(calls, CREATE).length, 0);
    } finally {
      cleanup();
    }
  });
});

test("#1099: a folder over 3 windows of 23 is refused with a Varity action before any call", async () => {
  // 80 images: 4 commits of 20, so 2 + 4 x 23 = 94 units (5 windows); 60 images: 2 + 3 x 23 = 71 (4 windows).
  for (const images of [80, 60]) {
    const { dir, cleanup } = project(many(images, (i) => [`img${String(i).padStart(2, "0")}.png`, PNG]));
    try {
      const { isError, out, calls } = await deploy({ path: dir }, base, { uploadOff: true });
      assert.equal(isError, true, String(images));
      assert.equal(out.error.code, "FOLDER_TOO_LARGE_FOR_VARITY", String(images));
      assert.deepEqual(calls, [], String(images));
      const action = out.error.suggestion;
      assert.ok(action.includes(CHAT_AND_BUILD), action);
      assert.match(action, /varity_list_templates/);
      assert.match(action, /image/);
    } finally {
      cleanup();
    }
  }
});

test("SP30-1: the run read after the create is cut to the 230 s hard deadline, and skipped when no time is left", async () => {
  const realNow = Date.now;
  const t0 = realNow();
  let offset = 0;
  Date.now = () => t0 + offset;
  try {
    for (const [createdAt, readTimeout] of [[225_000, 5_000], [230_000, undefined]]) {
      offset = 0;
      const p = project();
      try {
        const { isError, out, calls } = await withTimeouts((timeout) => deploy({ path: p.dir }, base, {
          clock: (call) => {
            if (call.route === CREATE) offset = createdAt;
            if (call.route.startsWith("GET /api/deployments/runs/")) call.timeout = timeout();
          },
        }));
        assert.equal(isError, false, JSON.stringify(out));
        const reads = of(calls, "GET /api/deployments/runs/" + RUN_ID);
        if (readTimeout === undefined) {
          assert.equal(reads.length, 0, "no time left: the run is not read");
          assert.equal(out.data.public_status, null);
          assert.equal(out.data.run_id, RUN_ID);
        } else {
          assert.equal(reads.length, 1);
          assert.equal(reads[0].timeout, readTimeout);
        }
      } finally {
        p.cleanup();
      }
    }
  } finally {
    Date.now = realNow;
  }
});

test("ST30-3/SP30-2: pacing ends on its own: a sleep that never advances the clock, against a gateway that always answers 429, gives at most 3 paced waits per send, then busy", { timeout: 10_000 }, async () => {
  const { pacing } = await import("../dist/tools/deploy-private-copy.js");
  const realSleep = pacing.sleep;
  pacing.sleep = async () => {};
  const always429 = [[429, { code: "hosted_capacity_exhausted", message: "Varity is busy." }, { "Retry-After": "5" }]];
  try {
    for (const route of [HOSTED, CHANGES]) {
      const { dir, cleanup } = project();
      try {
        const { isError, out, calls } = await deploy({ path: dir }, { ...base, [route]: always429 });
        assert.equal(isError, true, route);
        assert.equal(out.error.code, "hosted_capacity_exhausted", route);
        assert.equal(out.error.suggestion, "Call varity_deploy again with the same path after 5 seconds.", route);
        assert.equal(of(calls, route).length, 4, `${route}: one send and 3 paced resends`);
        assert.equal(of(calls, CREATE).length, 0);
      } finally {
        cleanup();
      }
    }
  } finally {
    pacing.sleep = realSleep;
  }
});

test("SP30-2: each paced wait is the served Retry-After plus 1 s plus 0-3 s of jitter", async () => {
  await withPacedClock(async (clock) => {
    for (let run = 0; run < 3; run += 1) {
      const { dir, cleanup } = project(many(32, (i) => [`img${String(i).padStart(2, "0")}.png`, PNG]));
      try {
        clock.offset = 0;
        const { isError } = await deploy({ path: dir }, { ...base, ...minuteLedger(clock) }, { uploadOff: true });
        assert.equal(isError, false);
      } finally {
        cleanup();
      }
    }
    assert.ok(clock.slept.length >= 6, String(clock.slept.length));
    for (const ms of clock.slept) assert.ok(ms >= 1_000 && ms <= 64_000, String(ms));
    // Every wait lands 1-4 s after a window boundary (the stub's windows start at offset 0).
    assert.ok(clock.slept.some((ms) => ms % 1000 !== 0), `no jitter: ${clock.slept}`);
  });
});

test("SP30-5: an unpaced 429 after a commit landed answers FOLDER_SAVE_INCOMPLETE with the served wait", async () => {
  const { dir, cleanup } = project(many(60, (i) => [`f${String(i).padStart(2, "0")}.txt`, `${i}\n`]));
  try {
    const { isError, out, calls } = await deploy({ path: dir }, {
      ...base,
      [CHANGES]: [
        [201, { branch: "b", commit_sha: sha(1), base_sha: sha(999) }],
        [429, { code: "rate_limited", message: "Too many saves by your API keys." }, { "Retry-After": "1800" }],
      ],
    }, { uploadOff: true });
    assert.equal(isError, true);
    assert.equal(out.error.code, "FOLDER_SAVE_INCOMPLETE");
    assert.equal(out.error.suggestion, "Call varity_deploy again with the same path after 1800 seconds.");
    assert.equal(of(calls, CHANGES).length, 2);
    assert.equal(of(calls, CREATE).length, 0);
  } finally {
    cleanup();
  }
});
