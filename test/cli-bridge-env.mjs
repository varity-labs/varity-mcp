import assert from "node:assert/strict";
import { test } from "node:test";

const { execCLI } = await import("../dist/utils/cli-bridge.js");

test("execCLI forces machine-readable child output by removing color env", async () => {
  const script = [
    "process.stdout.write(JSON.stringify({",
    "forceColor: process.env.FORCE_COLOR ?? null,",
    "noColor: process.env.NO_COLOR ?? null,",
    "cliColor: process.env.CLICOLOR ?? null,",
    "pyColors: process.env.PY_COLORS ?? null",
    "}))",
  ].join("");

  const result = await execCLI(process.execPath, ["-e", script], {
    env: { FORCE_COLOR: "1" },
  });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.forceColor, null);
  assert.equal(parsed.noColor, "1");
  assert.equal(parsed.cliColor, "0");
  assert.equal(parsed.pyColors, "0");
});
