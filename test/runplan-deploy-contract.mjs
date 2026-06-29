import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const deployTool = readFileSync(new URL("../src/tools/deploy.ts", import.meta.url), "utf8");
const agentTool = readFileSync(new URL("../src/tools/agent.ts", import.meta.url), "utf8");
const migrateTool = readFileSync(new URL("../src/tools/migrate.ts", import.meta.url), "utf8");
const cliBridge = readFileSync(new URL("../src/utils/cli-bridge.ts", import.meta.url), "utf8");
const deployTimeout = readFileSync(new URL("../src/utils/deploy-timeout.ts", import.meta.url), "utf8");

test("varity_deploy forwards RUNPLAN runtime override flags", () => {
  for (const flag of ["--command", "--arg", "--health-path", "--memory-mb", "--cpu-units", "--storage-mb"]) {
    assert.match(deployTool, new RegExp(`args\\.push\\("${flag.replace("-", "\\-")}"`));
  }
});

test("varity_deploy marks spawned varitykit process as MCP-originated", () => {
  assert.match(deployTool, /env:\s*\{\s*VARITY_CLIENT_SURFACE:\s*"mcp"\s*\}/);
});

test("deploy tools use the shared 10 minute user-facing timeout", () => {
  assert.match(deployTimeout, /DEPLOY_TIMEOUT_MS\s*=\s*600_000/);
  assert.match(deployTool, /utils\/deploy-timeout\.js/);
  assert.match(deployTool, /timeout:\s*DEPLOY_TIMEOUT_MS/);
  assert.match(agentTool, /utils\/deploy-timeout\.js/);
  assert.match(agentTool, /timeout:\s*DEPLOY_TIMEOUT_MS/);
  assert.match(migrateTool, /utils\/deploy-timeout\.js/);
  assert.match(migrateTool, /timeout:\s*DEPLOY_TIMEOUT_MS/);
});

test("execVaritykit preserves environment overrides through direct and python fallback execution", () => {
  assert.match(cliBridge, /env\?: NodeJS\.ProcessEnv/);
  assert.match(cliBridge, /execCLI\("varitykit", \[subcommand, \.\.\.args\], options\)/);
  assert.match(cliBridge, /execCLI\("python", \["-m", "varitykit", subcommand, \.\.\.args\], options\)/);
});
