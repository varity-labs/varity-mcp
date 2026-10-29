import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

function archive(version) {
  const body = Buffer.from(JSON.stringify({ name: "safe-fixture", version }));
  const header = Buffer.alloc(512);
  header.write("package/package.json");
  for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, body.length], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
  }
  header.fill(" ", 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]));
}

async function installCommands() {
  const commands = [];
  for (const path of [".github/workflows/ci.yml", ".github/workflows/publish-npm.yml"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/^\s*(?:-\s*)?run:\s*(npm (?:ci|install)[^\n]*)$/gm)) {
      commands.push({ path, args: match[1].trim().split(/\s+/).slice(1) });
    }
  }
  assert.equal(commands.length, 3, "all three producer installs must remain observable");
  return commands;
}

async function executeInstall(args, { drift = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-install-privacy-"));
  const archives = new Map(["1.0.0", "2.0.0"].map(version => [version, archive(version)]));
  const requests = [];
  let registry;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") return response.end("{}");
    const version = /^\/safe-fixture-(1\.0\.0|2\.0\.0)\.tgz$/.exec(request.url)?.[1];
    if (version) return response.end(archives.get(version));
    if (request.url === "/safe-fixture") {
      return response.end(JSON.stringify({ name: "safe-fixture", "dist-tags": { latest: "2.0.0" }, versions: Object.fromEntries([...archives].map(([version, bytes]) => [version, {
        name: "safe-fixture", version, dist: { tarball: `${registry}/safe-fixture-${version}.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` },
      }])) }));
    }
    response.writeHead(404).end("{}");
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${server.address().port}`;
    const locked = { name: "private-mcp-fixture", version: "1.0.0", dependencies: { "safe-fixture": "1.0.0" } };
    const manifest = structuredClone(locked);
    if (drift) manifest.dependencies["safe-fixture"] = "2.0.0";
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    const lock = JSON.stringify({ name: locked.name, version: locked.version, lockfileVersion: 3, requires: true, packages: {
      "": locked, "node_modules/safe-fixture": { version: "1.0.0", resolved: `${registry}/safe-fixture-1.0.0.tgz`, integrity: `sha512-${createHash("sha512").update(archives.get("1.0.0")).digest("base64")}` },
    } });
    await writeFile(join(directory, "package-lock.json"), lock);
    for (const name of ["user-config", "global-config"]) await writeFile(join(directory, name), "");
    await mkdir(join(directory, "cache"));
    const result = await new Promise((resolve, reject) => {
      const child = spawn("npm", [...args, "--ignore-scripts", "--no-fund", "--registry", registry, "--cache", join(directory, "cache")], {
        cwd: directory, timeout: 20_000, stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: process.env.PATH, NODE_ENV: "test", NPM_CONFIG_AUDIT: "true", NPM_CONFIG_USERCONFIG: join(directory, "user-config"), NPM_CONFIG_GLOBALCONFIG: join(directory, "global-config"), NPM_CONFIG_UPDATE_NOTIFIER: "false" },
      });
      let error = "";
      child.stderr.on("data", chunk => { error += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, error }));
    });
    return { ...result, requests, lock, actualLock: await readFile(join(directory, "package-lock.json"), "utf8"), installed: await readFile(join(directory, "node_modules/safe-fixture/package.json"), "utf8").then(JSON.parse).catch(() => null) };
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("every actual MCP dependency install prevents metadata upload under inherited audit=true", async () => {
  for (const { path, args } of await installCommands()) {
    const result = await executeInstall(args);
    assert.equal(result.code, 0, `${path}: ${result.error}`);
    assert.equal(result.installed?.version, "1.0.0");
    assert.deepEqual(result.requests.filter(request => request.method === "POST"), [], `${path} install must not upload dependency metadata`);
  }
});

test("every actual MCP dependency install refuses manifest-lock drift without repairing the lock", async () => {
  for (const { path, args } of await installCommands()) {
    const result = await executeInstall(args, { drift: true });
    assert.notEqual(result.code, 0, `${path} must reject an inconsistent reviewed lock`);
    assert.match(result.error, /EUSAGE/);
    assert.equal(result.actualLock, result.lock);
    assert.equal(result.installed, null);
    assert.deepEqual(result.requests.filter(request => request.method === "POST"), []);
  }
});
