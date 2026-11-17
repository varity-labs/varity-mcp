/**
 * The MCP Registry reads server.json; its versions must be the package's own
 * so a registry publish never names an unpublished or stale npm version.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import server from "../server.json" with { type: "json" };

test("server.json versions and name equal package.json", () => {
  assert.equal(server.version, packageMetadata.version);
  assert.equal(server.packages[0].version, packageMetadata.version);
  assert.equal(server.packages[0].identifier, packageMetadata.name);
  assert.equal(server.name, packageMetadata.mcpName);
  assert.equal(server.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
});
