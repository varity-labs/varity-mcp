/**
 * Every tool advertises a title and all four MCP hints explicitly, so a host
 * never falls back to the spec defaults (destructive, non-idempotent,
 * open-world). The expected table is distribution plan §2a, copied as
 * literals: readOnly / destructive / idempotent / openWorld.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createVarityServer } = await import("../dist/server.js");

const READ = [true, false, true, true];
const EXPECTED = {
  varity_search_docs: READ,
  varity_cost_calculator: READ,
  varity_balance: READ,
  varity_doctor: READ,
  varity_deploy_status: READ,
  varity_deploy_logs: READ,
  varity_machines_list: READ,
  varity_list_templates: READ,
  varity_template_info: READ,
  varity_list_agents: READ,
  varity_agent_info: READ,
  varity_migrate: [true, false, true, true],
  varity_set_env: [true, false, true, false],
  varity_login: [false, false, true, false],
  // Not in the §2a table yet (A5 adds the tool): revokes the saved key on Varity, then deletes it.
  varity_logout: [false, true, true, false],
  varity_open_browser: [false, false, true, false],
  varity_build: [false, false, true, false],
  varity_dev_server: [false, false, false, false],
  varity_install_deps: [false, false, true, true],
  varity_create_repo: [false, false, false, true],
  varity_deploy: [false, false, false, true],
  varity_deploy_template: [false, false, false, true],
  varity_deploy_agent: [false, false, false, true],
  varity_machines_create: [false, false, false, true],
  varity_redeploy: [false, true, false, true],
  varity_delete_deployment: [false, true, true, true],
  varity_machines_delete: [false, true, true, true],
};

test("tools/list annotations equal the binding §2a table for all 27 tools", async () => {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "annotation-audit", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();

  assert.equal(tools.length, 27);
  const actual = Object.fromEntries(tools.map((tool) => {
    const a = tool.annotations ?? {};
    return [tool.name, [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint]];
  }));
  assert.deepEqual(actual, EXPECTED);
  for (const tool of tools) {
    assert.equal(typeof tool.title, "string", `${tool.name} title`);
    assert.ok(tool.title.length > 0, `${tool.name} title`);
  }
});
