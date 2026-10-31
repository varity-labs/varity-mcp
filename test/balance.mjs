import assert from "node:assert/strict";
import { test } from "node:test";

process.env.VARITY_GATEWAY_URL = "https://gw.test";
process.env.VARITY_API_KEY = "test-deploy-key";
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

async function balance(body, status = 200, arguments_ = {}) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createVarityServer();
  await server.connect(serverSide);
  const client = new Client({ name: "balance-journey", version: "1" });
  await client.connect(clientSide);
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.Authorization });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  try {
    const catalog = await client.listTools();
    const response = await client.callTool({ name: "varity_balance", arguments: arguments_ });
    const text = response.content[0].text;
    return { response, output: text.startsWith("{") ? JSON.parse(text) : null, calls,
      definition: catalog.tools.find((tool) => tool.name === "varity_balance") };
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
  }
}

test("the agent reads the owner's exact USD balance using its deploy key, without billing-account PII", async () => {
  const { output, calls } = await balance({ availableE8: "8113000000", reservedE8: "1200000000", debtE8: "0", email: "must-not-leak@example.test" });
  assert.equal(output.success, true);
  assert.deepEqual(output.data, { currency: "USD", available_usd: "81.13", reserved_usd: "12.00", debt_usd: "0.00", source: "varity_public_api:/api/credits/balance" });
  assert.match(output.message, /Available \$81\.13/);
  assert.equal(calls[0].url, "https://gw.test/api/credits/balance");
  assert.equal(calls[0].authorization, "Bearer test-deploy-key");
  assert.doesNotMatch(JSON.stringify(output), /must-not-leak|billing\/account|credit(?!s\/balance)/i);
});

test("authorization maximum is named without implying it reduces the served available balance", async () => {
  const { output, definition } = await balance({ availableE8: "10000000000", reservedE8: "4506000000", debtE8: "0" });
  assert.deepEqual(output.data, {
    currency: "USD", available_usd: "100.00", reserved_usd: "45.06", debt_usd: "0.00",
    source: "varity_public_api:/api/credits/balance",
  });
  assert.equal(output.message, "Available $100.00, authorization maximum $45.06, owed $0.00 (USD).");
  assert.match(definition.description, /reserved_usd is the served authorization maximum/);
});

test("exact USD preserves sub-cent amounts and balances beyond floating-point integer precision", async () => {
  const { output } = await balance({ availableE8: "1", reservedE8: "9007199254740993", debtE8: "9223372036854775807" });
  assert.equal(output.data.available_usd, "0.00000001");
  assert.equal(output.data.reserved_usd, "90071992.54740993");
  assert.equal(output.data.debt_usd, "92233720368.54775807");
  assert.match(output.message, /Available \$0\.00000001/);
});

test("a measured zero is distinct from missing, malformed and unavailable money", async () => {
  const zero = await balance({ availableE8: "0", reservedE8: "0", debtE8: "0" });
  assert.equal(zero.output.data.available_usd, "0.00");
  for (const field of ["availableE8", "reservedE8", "debtE8"]) {
    for (const value of [undefined, null, 0, -1, "-1", "", "1.2", "NaN"]) {
      const { response, output } = await balance({ availableE8: "8113000000", reservedE8: "0", debtE8: "0", [field]: value });
      assert.equal(response.isError, true, `${field}=${String(value)}`);
      assert.equal(output.error.code, "balance_unavailable");
      assert.equal(output.data, undefined);
      assert.doesNotMatch(output.error.message, /\$0/);
    }
  }
  const down = await balance({ code: "balance_unavailable", message: "Balance is unavailable", retryable: true }, 503);
  assert.equal(down.output.error.code, "balance_unavailable");
  assert.equal(down.output.data, undefined);
});

test("a rejected key stays a key error, and no tool argument can select another owner", async () => {
  const denied = await balance({ code: "invalid_api_key", message: "Invalid key" }, 401);
  assert.equal(denied.output.error.code, "invalid_api_key");
  const override = await balance({}, 200, { owner_id: "another-owner" });
  assert.equal(override.response.isError, true);
  assert.deepEqual(override.calls, []);
});
