import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const { classifyReadiness, verifyAuthentication } = await import("../dist/tools/doctor.js");
const { projectOwnerPricing } = await import("../dist/tools/cost-calculator.js");
const { deployTemplate } = await import("../dist/tools/agent.js");
const { secureSetEnvRefusal } = await import("../dist/tools/set-env.js");
const { configuredCredentialResponse } = await import("../dist/tools/login.js");
const { VarityPublicApiError } = await import("../dist/utils/public-api.js");

function payload(response) {
  return JSON.parse(response.content[0].text);
}

test("CLI deployment readiness depends on varitykit and auth, not Node or npm", () => {
  const result = classifyReadiness([
    { name: "Node.js", status: "fail" },
    { name: "npm", status: "fail" },
    { name: "varitykit CLI", status: "pass" },
    { name: "Authentication", status: "pass" },
  ]);
  assert.equal(result.developmentReady, false);
  assert.equal(result.cliDeployReady, true);
  assert.deepEqual(result.cliIssues, []);
});

test("doctor requires owner verification rather than credential presence", async () => {
  const valid = await verifyAuthentication("present-key", async () => ({ deployments: [] }));
  assert.equal(valid.status, "pass");

  const revoked = await verifyAuthentication("present-key", async () => {
    throw new VarityPublicApiError("Credential rejected.", "NOT_AUTHENTICATED", 401);
  });
  assert.equal(revoked.status, "fail");
  assert.match(revoked.message, /authentication was rejected/i);
  assert.match(revoked.fix, /varitykit auth login/i);

  const unreachable = await verifyAuthentication("present-key", async () => {
    throw new VarityPublicApiError(
      "Could not reach the Varity API.",
      "VARITY_API_UNREACHABLE",
      undefined,
      "Check your connection and retry."
    );
  });
  assert.equal(unreachable.status, "fail");
  assert.match(unreachable.message, /deployment readiness could not be verified/i);
  assert.equal(unreachable.fix, "Check your connection and retry.");
  assert.doesNotMatch(unreachable.fix, /auth login/i);

  const missing = await verifyAuthentication(null, async () => {
    throw new Error("must not run");
  });
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /no deploy key found/i);
});

test("login reports configured credentials as unverified", () => {
  const result = payload(configuredCredentialResponse());
  assert.equal(result.data.credential_present, true);
  assert.equal(result.data.authentication_verified, false);
  assert.equal(result.data.authenticated, undefined);
  assert.match(result.message, /has not been verified/i);
});

test("pricing projection preserves owner monthly and hourly units", () => {
  assert.deepEqual(
    projectOwnerPricing({ fixed_monthly_cost_usd: 25 }),
    { unit: "month", fixed_monthly_cost_usd: 25 }
  );
  assert.deepEqual(
    projectOwnerPricing({
      billing_model: "hourly_resource_reservation",
      hourly_cost_usd: 0.42,
    }),
    { unit: "hour", hourly_cost_usd: 0.42 }
  );
  assert.equal(projectOwnerPricing({ billing_model: "hourly_resource_reservation" }), null);
});

test("login guidance consistently routes secret entry to the trusted terminal", async () => {
  const [readme, publicApi] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../src/utils/public-api.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(readme, /varity_login` \| Authenticate with your deploy key/);
  assert.doesNotMatch(publicApi, /Run varity_login with a Developer Portal deploy key/);
  assert.match(readme, /varitykit auth login/);
  assert.match(publicApi, /varitykit auth login/);
});

test("private and required-secret templates fail before the deploy command", async () => {
  for (const template of [
    { id: "private-template", private: true, requiredEnv: [] },
    { id: "secret-template", private: false, requiredEnv: ["API_KEY"] },
  ]) {
    const calls = [];
    const execute = async (subcommand, args) => {
      calls.push([subcommand, args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ templates: [template] }),
        stderr: "",
      };
    };
    const result = payload(await deployTemplate(template.id, undefined, execute));
    assert.equal(result.success, false);
    assert.equal(result.error.code, "SECURE_ENV_CONFIGURATION_REQUIRED");
    assert.deepEqual(calls, [["app", ["templates", "--json"]]]);
  }
});

test("set-env compatibility route refuses secret-bearing MCP input", () => {
  const result = payload(secureSetEnvRefusal());
  assert.equal(result.success, false);
  assert.equal(result.error.code, "SECURE_ENV_CONFIGURATION_REQUIRED");
  assert.match(result.error.suggestion, /Never place secret values in chat or MCP arguments/);
});
