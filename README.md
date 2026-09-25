# @varity-labs/mcp

[![npm](https://img.shields.io/npm/v/@varity-labs/mcp)](https://www.npmjs.com/package/@varity-labs/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/varity-labs/varity-mcp/blob/main/LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-yellow.svg)](https://github.com/varity-labs/varity-mcp)

> The published Varity MCP package for Cursor, Claude Code, VS Code, Windsurf, and other MCP clients.

This repository contains only `@varity-labs/mcp`, the npm MCP server. It is a thin tool wrapper around `varitykit` and Varity's gateway APIs; it is not the Python CLI, the portal, the dormant SDK, or an app-store package.

The Varity MCP Server lets a supported local AI coding client build, deploy, and manage supported apps in production for you.

**Quick start**: pick your editor below and run one command.

## Install

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "varity": {
      "command": "npx",
      "args": ["-y", "@varity-labs/mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add varity -- npx -y @varity-labs/mcp
```

### VS Code with Copilot

1. Command Palette → **MCP: Add Server**
2. Select **Command (stdio)**
3. Command: `npx -y @varity-labs/mcp`
4. Name: `Varity`

### Windsurf

Add to `mcp_config.json`:

```json
{
  "mcpServers": {
    "varity": {
      "command": "npx",
      "args": ["-y", "@varity-labs/mcp"]
    }
  }
}
```

### Any MCP-compatible client (stdio)

```json
{
  "mcpServers": {
    "varity": {
      "command": "npx",
      "args": ["-y", "@varity-labs/mcp"]
    }
  }
}
```

## What you can do from your AI editor

The MCP exposes Varity's deploy surface so your AI tool can take action — not just generate code. Try prompts like:

**Deploy your own code**
- "Deploy this project to production"
- "Ship this app live"
- "What would it cost to deploy this on Varity?"

**Deploy a supported public template (one command, no code required)**
- "What templates can Varity deploy?"
- "Which templates need no secrets?"
- "Deploy this public, secret-free template for me"

**Manage live deployments**
- "Show my deployments"
- "What's the URL of my last deploy?"
- "Stop my-app and stop billing it"
- "Get the build logs for my deployment"

**Preview a Vercel migration**
- "Preview what would change when migrating github.com/me/my-app"
- "Show me the Vercel-specific artifacts to replace"

**Docs and pricing**
- "Search Varity docs for environment variables"
- "What is the current estimate for this pricing profile?"
- "What billing projection does my deployed app report?"

## Tools

| Tool | What it does |
|---|---|
| `varity_search_docs` | Search the Varity documentation |
| `varity_cost_calculator` | Project the live owner's monthly or hourly estimate without converting units |
| `varity_doctor` | Check that your environment is ready to deploy |
| `varity_login` | Check authentication and route login through the trusted `varitykit auth login` terminal flow |
| `varity_install_deps` | Install project dependencies |
| `varity_build` | Build the project |
| `varity_open_browser` | Open a URL locally |
| `varity_dev_server` | Start the local development server |
| `varity_create_repo` | Create a GitHub repository and push the project |
| `varity_deploy` | Deploy the current project to production |
| `varity_deploy_status` | Check the status of a deployment |
| `varity_deploy_logs` | Read build and runtime logs |
| `varity_delete_deployment` | Stop a deployment and end its billing |
| `varity_set_env` | Preserve the public tool route while refusing secret values and directing configuration to a secret-safe interface |
| `varity_redeploy` | Reapply an existing deployment's saved configuration; unchanged input may be a no-op |
| `varity_machines_list` | List your CPU virtual machines (optionally the CPU VM profile catalog) |
| `varity_machines_create` | Quote and create a CPU virtual machine with your SSH public key |
| `varity_machines_delete` | Delete a CPU virtual machine and confirm its billing stopped |
| `varity_list_templates` | List certified gateway-owned Varity templates |
| `varity_template_info` | Show full details for one certified template |
| `varity_deploy_template` | Deploy a public certified template with no required secrets; refuse private or secret-bearing templates |
| `varity_list_agents` | Backward-compatible alias for `varity_list_templates` |
| `varity_agent_info` | Backward-compatible alias for `varity_template_info` |
| `varity_deploy_agent` | Backward-compatible alias for `varity_deploy_template` |
| `varity_migrate` | Preview Vercel-to-Varity source transformations without mutating or deploying |

## Templates

Varity templates come from the gateway-owned certified catalog. Ask your AI editor "what templates can I deploy?" and it will list the live catalog and inspect each template contract. The MCP deploy tool supports only public templates that declare no required environment variables; it refuses private or secret-bearing templates and routes those through an approved secret-safe interface.

Each template reserves different hardware. Use `varity_template_info` to see the required environment variables, private/public access mode, resources, hardware profile, and certification state before deciding whether the MCP can deploy it.

## End-to-end example

From empty folder to deployed app, all in natural language:

```
You: "Make me a simple landing page for my coffee shop and deploy it"
AI:  Wrote the landing page and ran its local build.
AI:  Deploy accepted. Tracking its durable run until the owner reports a terminal outcome.
AI:  The status owner now reports the app live at https://varity.app/coffee-shop/

You: "Now deploy Agent Zero"
AI:  Agent Zero is certified and does not require environment variables.
AI:  Template deploy accepted. No live URL is claimed until varity_deploy_status proves it.
```

## Pricing

Pricing profiles and values are owned by Varity's live public interface. Ask
your AI editor to use `varity_cost_calculator` for a current estimate; this
package intentionally embeds no price table or billing-policy copy.

## Transport

The package supports stdio for local MCP clients such as Cursor, Claude Code,
VS Code, and Windsurf.

```bash
npx -y @varity-labs/mcp
```

The former hosted endpoint and network transport are retired. Browser clients
that require a remote MCP URL are not supported by this package.

## Prerequisites

- **Node.js** >= 22.11 (the current supported LTS baseline; EOL Node 18/20 are unsupported)
- **For deployment**: `pip install varitykit`

---

**Deploy supported apps from your AI coding tool.**

[Documentation](https://docs.varity.so/ai-tools/mcp-server-spec) · [GitHub](https://github.com/varity-labs/varity-mcp) · [Discord](https://discord.gg/7vWsdwa2Bg)
