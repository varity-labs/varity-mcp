import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("logger preserves stdout as a clean JSON-RPC channel", () => {
  const script = `
    import { logger } from "./dist/utils/logger.js";
    logger.debug("debug diagnostic");
    logger.info("info diagnostic");
    logger.warn("warn diagnostic");
    logger.error("error diagnostic", {
      headers: { authorization: "Bearer synthetic-secret" },
      sessionId: "synthetic-session",
      ip: "203.0.113.10",
      "http.request.method": "ATTACKER-METHOD",
      "url.path": "/synthetic-secret/path",
      "error.type": "SyntheticError"
    });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "development", VARITY_MCP_LOG_LEVEL: "debug" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "diagnostics must never write to the JSON-RPC stdout channel");

  const entries = result.stderr.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.map(({ level }) => level), ["debug", "info", "warn", "error"]);
  assert.ok(entries.every(({ service }) => service === "varity-mcp"));
  assert.equal(entries[3]["error.type"], "SyntheticError");
  assert.equal(entries[3].headers, undefined);
  assert.equal(entries[3].sessionId, undefined);
  assert.equal(entries[3].ip, undefined);
  assert.equal(entries[3]["http.request.method"], "OTHER");
  assert.equal(entries[3]["url.path"], "/_other");
  assert.doesNotMatch(result.stderr, /synthetic-secret|synthetic-session|203\.0\.113\.10/);
});
