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
  // P9-ENV (V9-1): a gated restart of the app.
  varity_set_env: [false, true, false, true],
  varity_login: [false, false, true, false],
  // A5: revokes the saved key on Varity, then deletes it (recorded F/T/T/F).
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
  // P9-DOMAIN (V9-4).
  varity_domain_add: [false, false, true, true],
  varity_domain_verify: [false, false, true, true],
  varity_domain_remove: [false, true, true, true],
};

test("tools/list annotations equal the binding §2a table for all 30 tools", async () => {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createVarityServer().connect(serverSide);
  const client = new Client({ name: "annotation-audit", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();

  assert.equal(tools.length, 30);
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
