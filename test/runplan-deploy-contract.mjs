import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const deployTool = readFileSync(new URL("../src/tools/deploy.ts", import.meta.url), "utf8");
const cliBridge = readFileSync(new URL("../src/utils/cli-bridge.ts", import.meta.url), "utf8");

test("varity_deploy forwards RUNPLAN runtime override flags", () => {
  for (const flag of ["--command", "--arg", "--health-path", "--memory-mb", "--cpu-units", "--storage-mb"]) {
    assert.match(deployTool, new RegExp(`args\\.push\\("${flag.replace("-", "\\-")}"`));
  }
});

test("varity_deploy marks spawned varitykit process as MCP-originated", () => {
  assert.match(deployTool, /env:\s*\{\s*VARITY_CLIENT_SURFACE:\s*"mcp"\s*\}/);
});

test("execVaritykit preserves environment overrides through direct and python fallback execution", () => {
  assert.match(cliBridge, /env\?: NodeJS\.ProcessEnv/);
  assert.match(cliBridge, /execCLI\("varitykit", \[subcommand, \.\.\.args\], options\)/);
  assert.match(cliBridge, /execCLI\("python", \["-m", "varitykit", subcommand, \.\.\.args\], options\)/);
});
