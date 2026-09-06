/**
 * Regression tests from the 2026-09-06 new-developer launch audit.
 *
 * - varity_login reported success when varitykit printed "Invalid deploy key" and exited 0.
 * - A varitykit too old for `app templates` surfaced click usage text with a "run varity_login" hint.
 * - Tool annotations the docs promise (readOnlyHint / destructiveHint) were missing on the
 *   template and lifecycle tools, so MCP hosts could not tell a read from a teardown.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const { isOutdatedVaritykit } = await import("../dist/utils/cli-bridge.js");
const { loginRejected } = await import("../dist/tools/login.js");

test("loginRejected: exit 0 with 'Invalid deploy key' is a rejection", () => {
  assert.equal(loginRejected({ exitCode: 0, stdout: "  Invalid deploy key. It should be at least 10 characters.", stderr: "" }), true);
  assert.equal(loginRejected({ exitCode: 1, stdout: "", stderr: "boom" }), true);
  assert.equal(loginRejected({ exitCode: 0, stdout: "Deploy key saved securely.", stderr: "" }), false);
});

test("isOutdatedVaritykit: click 'No such command' is an outdated CLI, not an auth problem", () => {
  assert.equal(isOutdatedVaritykit({ exitCode: 2, stdout: "", stderr: "Usage: varitykit app [OPTIONS]...\nError: No such command 'templates'." }), true);
  assert.equal(isOutdatedVaritykit({ exitCode: 1, stdout: "", stderr: "Not authenticated" }), false);
  assert.equal(isOutdatedVaritykit({ exitCode: 0, stdout: "{}", stderr: "" }), false);
});

test("tools/list carries the annotations the docs promise", async () => {
  const proc = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "ignore"] });
  const send = (m) => proc.stdin.write(JSON.stringify(m) + "\n");
  const lines = [];
  const done = new Promise((resolve) => {
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        lines.push(msg);
        if (msg.id === 2) resolve();
      }
    });
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await done;
  proc.kill();
  const tools = Object.fromEntries(lines.find((m) => m.id === 2).result.tools.map((t) => [t.name, t]));
  for (const name of ["varity_list_templates", "varity_template_info", "varity_list_agents", "varity_agent_info"]) {
    assert.equal(tools[name]?.annotations?.readOnlyHint, true, `${name} readOnlyHint`);
  }
  for (const name of ["varity_deploy_template", "varity_deploy_agent", "varity_delete_deployment", "varity_set_env", "varity_redeploy"]) {
    assert.equal(tools[name]?.annotations?.destructiveHint, true, `${name} destructiveHint`);
  }
});
