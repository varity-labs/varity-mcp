# @varity-labs/mcp

[![npm](https://img.shields.io/npm/v/@varity-labs/mcp)](https://www.npmjs.com/package/@varity-labs/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/varity-labs/varity-mcp/blob/main/LICENSE)

> The published Varity MCP package for Cursor, Claude Code, VS Code, Windsurf, and other MCP clients.

This repository contains only `@varity-labs/mcp`, the npm MCP server. It is a thin tool wrapper around `varitykit` and Varity's gateway APIs; it is not the Python CLI, the portal, the dormant SDK, or an app-store package.

The Varity MCP Server lets your AI editor build, deploy, and manage supported apps in production for you. Each paid app bills up to a fixed monthly maximum for the resources it reserves, prorated by running time; static sites are free for verified accounts. One server, every AI client, zero commands.

**Browser usage**: see the [browser usage guide](https://docs.varity.so/ai-tools/browser-usage) for Claude.ai or ChatGPT browser.
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

### Claude.ai / ChatGPT (HTTP)

The configured hosted endpoint is:

```
https://mcp.varity.so
```

Before using it for owner-scoped operations, check
`varity-engineering/CURRENT-STATE.md` for exact-release OAuth and owner-binding
evidence. A reachable endpoint or healthy process is not authorization proof;
use stdio when that evidence is absent.

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

**Deploy a certified template (one command, no code required)**
- "What templates can Varity deploy?"
- "Spin up Agent Zero"
- "Deploy a private app template for me"

**Manage live deployments**
- "Show my deployments"
- "What's the URL of my last deploy?"
- "Stop my-app and stop billing it"
- "Get the build logs for my deployment"

**Migrate from Vercel**
- "Migrate my Vercel app at github.com/me/my-app to Varity"
- "Preview what changes the migration will make"

**Docs and pricing**
- "Search Varity docs for environment variables"
- "How much would it cost to host a 5,000-user API on Varity?"
- "What's my monthly cost going to be if my app gets traction?"

## Tools

| Tool | What it does |
|---|---|
| `varity_search_docs` | Search the Varity documentation |
| `varity_cost_calculator` | Estimate your monthly cost before you deploy |
| `varity_doctor` | Check that your environment is ready to deploy |
| `varity_login` | Authenticate with your deploy key |
| `varity_install_deps` | Install project dependencies |
| `varity_build` | Build the project |
| `varity_open_browser` | Open a URL locally (stdio transports only) |
| `varity_dev_server` | Start the local development server (stdio transports only) |
| `varity_create_repo` | Create a GitHub repository and push the project |
| `varity_deploy` | Deploy the current project to production |
| `varity_deploy_status` | Check the status of a deployment |
| `varity_deploy_logs` | Read build and runtime logs |
| `varity_delete_deployment` | Stop a deployment and end its billing |
| `varity_set_env` | Set or replace environment variables on a live deployment, then redeploy |
| `varity_redeploy` | Reapply an existing deployment's saved configuration; unchanged input may be a no-op |
| `varity_list_templates` | List certified gateway-owned Varity templates |
| `varity_template_info` | Show full details for one certified template |
| `varity_deploy_template` | Deploy a certified template by ID |
| `varity_list_agents` | Backward-compatible alias for `varity_list_templates` |
| `varity_agent_info` | Backward-compatible alias for `varity_template_info` |
| `varity_deploy_agent` | Backward-compatible alias for `varity_deploy_template` |
| `varity_migrate` | Migrate an app from Vercel to Varity |

## Templates

Varity templates come from the gateway-owned certified catalog. Ask your AI editor "what templates can I deploy?" or "deploy Agent Zero for me" and it will list the live catalog, inspect that template contract, and deploy it through `varitykit app deploy --template <id>`.

Each template reserves different hardware. Use `varity_template_info` to see the required environment variables, private/public access mode, resources, hardware profile, and certification state before deploying.

## End-to-end example

From empty folder to deployed app, all in natural language:

```
You: "Make me a simple landing page for my coffee shop and deploy it"
AI:  Wrote the landing page, ran the build, deployed live at
     https://varity.app/coffee-shop/

You: "Now deploy Agent Zero"
AI:  Agent Zero is certified and does not require environment variables.
AI:  Deployed Agent Zero at https://varity.app/my-agent/
```

## How Varity is priced

- **Fixed monthly maximum per app**: set by the resources your app reserves, billed prorated by running time. Static sites are free for verified accounts.
- **No usage meters**: for an unchanged profile, traffic alone does not change the price. Changing resources, services, replicas, accelerators, or app count can.
- **Preset resource menu**: dynamic apps select a Managed Cloud preset (Starter, Growth, Scale, Pro); presets differ in reserved resources, not gated features.

Ask your AI editor "how much would this app cost on Varity?" and it will use `varity_cost_calculator` to estimate before you deploy.

## Transports

### stdio (default)

For desktop AI editors. Cursor, Claude Code, VS Code, Windsurf.

```bash
npx -y @varity-labs/mcp
```

### HTTP

For browser-based AI tools. Claude.ai, ChatGPT.

```bash
npx -y @varity-labs/mcp --transport http --port 3100
```

For authenticated hosted use, require the exact-release evidence recorded in
`varity-engineering/CURRENT-STATE.md`. Otherwise use stdio for owner-scoped
operations.

## Prerequisites

- **Node.js** >= 18
- **For deployment**: `pip install varitykit`

## Cost

Varity bills each paid deployment up to a fixed monthly maximum for the reserved profile, prorated by running time. For an unchanged profile, the bill does not grow with traffic, requests, or build minutes. Static sites are free for verified accounts. Use the `varity_cost_calculator` tool from your AI editor for a detailed estimate before you deploy.

---

**Deploy supported apps from your AI coding tool.** Resource-based pricing with a fixed monthly maximum per app — no usage meters.

[Documentation](https://docs.varity.so/ai-tools/mcp-server-spec) · [GitHub](https://github.com/varity-labs/varity-mcp) · [Discord](https://discord.gg/7vWsdwa2Bg)
