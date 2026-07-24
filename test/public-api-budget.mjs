import assert from "node:assert/strict";
import { test } from "node:test";

process.env["VARITY_GATEWAY_URL"] = "https://staging.varity.example";

const { INFRASTRUCTURE } = await import("../dist/utils/config.js");
const { PUBLIC_API_GET_TIMEOUT_MS } = await import("../dist/utils/public-api.js");

test("public API reads honor the configured gateway endpoint", () => {
  assert.equal(INFRASTRUCTURE.GATEWAY, "https://staging.varity.example");
});

test("public API reads outlive bounded gateway reconciliation", () => {
  assert.equal(PUBLIC_API_GET_TIMEOUT_MS, 60_000);
});
