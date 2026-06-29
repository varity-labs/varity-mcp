import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const deployTool = readFileSync(new URL("../src/tools/deploy.ts", import.meta.url), "utf8");
const agentTool = readFileSync(new URL("../src/tools/agent.ts", import.meta.url), "utf8");
const migrateTool = readFileSync(new URL("../src/tools/migrate.ts", import.meta.url), "utf8");
const cliBridge = readFileSync(new URL("../src/utils/cli-bridge.ts", import.meta.url), "utf8");
const deployTimeout = readFileSync(new URL("../src/utils/deploy-timeout.ts", import.meta.url), "utf8");
const reEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("varity_deploy forwards RUNPLAN runtime override flags", () => {
  for (const flag of ["--command", "--arg", "--health-path", "--dockerfile-path", "--docker-context-path", "--memory-mb", "--cpu-units", "--storage-mb", "--service"]) {
    assert.match(deployTool, new RegExp(`args\\.push\\("${reEscape(flag)}"`));
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

test("varity_deploy prefers the current CLI URL over stale local deployment receipts", () => {
  assert.match(deployTool, /function extractDeployUrl\(output: string\): string \| null/);
  assert.match(deployTool, /const cliDeployUrl = extractDeployUrl\(output\)/);
  assert.match(deployTool, /let deployUrl = cliDeployUrl \?\? "unknown"/);
  assert.match(deployTool, /if \(!cliDeployUrl && jsonFiles\.length > 0\)/);
});

test("varity_deploy can derive share cards from dynamic subdomain URLs", () => {
  assert.match(deployTool, /function varitySlugFromUrl\(url: string\): string \| null/);
  assert.match(deployTool, /const dynamicMatch = url\.match/);
  assert.match(deployTool, /const staticMatch = url\.match/);
  assert.match(deployTool, /cardUrl = `https:\/\/varity\.app\/card\/\$\{varitySlug\}`/);
});

test("varity_deploy surfaces deploy-api validation failures before generic CLI crash handling", () => {
  assert.match(deployTool, /function extractDeployFailure\(output: string\)/);
  const deployFailureIndex = deployTool.indexOf("const deployFailure = extractDeployFailure(output)");
  const abortedIndex = deployTool.indexOf('if (output.includes("Aborted") || result.exitCode === 137)');
  assert.ok(deployFailureIndex > -1);
  assert.ok(abortedIndex > -1);
  assert.ok(deployFailureIndex < abortedIndex);
  assert.match(deployTool, /"IMAGE_PREFLIGHT_FAILED"/);
});
