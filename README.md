# @varity-labs/mcp

[![npm](https://img.shields.io/npm/v/@varity-labs/mcp)](https://www.npmjs.com/package/@varity-labs/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/varity-labs/varity-mcp/blob/main/LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-yellow.svg)](https://github.com/varity-labs/varity-mcp)

> Deploy production apps and AI agents from Cursor, Claude Code, VS Code, Windsurf, or ChatGPT. Flat predictable pricing — your bill stays the same as your app grows.

The Varity MCP Server lets your AI editor scaffold, deploy, and manage apps in production for you. Flat monthly cost per app, locked at deploy time based on hardware reserved — no usage-based billing, no surprise overages. One server, every AI client, zero commands.

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

Use the hosted server URL:

```
https://mcp.varity.so
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

**Deploy a ready-made AI agent (one command, no code required)**
- "Deploy a Telegram chatbot for me"
- "Spin up Agent Zero"
- "I want a Claude-compatible chat UI"
- "What AI agents can Varity deploy?"

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
| `varity_init` | Scaffold a new Next.js project |
| `varity_install_deps` | Install project dependencies |
| `varity_build` | Build the project |
| `varity_open_browser` | Open a URL locally (stdio transports only) |
| `varity_dev_server` | Start the local development server (stdio transports only) |
| `varity_create_repo` | Create a GitHub repository and push the project |
| `varity_deploy` | Deploy the current project to production |
| `varity_deploy_status` | Check the status of a deployment |
| `varity_deploy_logs` | Read build and runtime logs |
| `varity_delete_deployment` | Stop a deployment and end its billing |
| `varity_list_agents` | List the curated AI agent templates Varity can deploy |
| `varity_agent_info` | Show full details for one AI agent template (env vars, ports, cost) |
| `varity_deploy_agent` | Deploy a curated AI agent template by name |
| `varity_migrate` | Migrate an app from Vercel to Varity |

## AI agent templates

Varity ships 5 curated AI agent templates that deploy with one command and no code from you:

| Agent | What it is |
|---|---|
| `hermes` | Self-hosted Telegram chatbot powered by an LLM |
| `openclaw` | Claude-compatible web chat UI with persistent history |
| `agent-zero` | General-purpose AI agent framework — zero required env vars |
| `autoresearch` | GPU-backed CUDA workstation (SSH access) |
| `eliza-venice` | ElizaOS agent for Twitter/X automation |

Ask your AI editor "what AI agents can I deploy?" or "deploy hermes for me" and it will use the agent tools above. Each agent reserves different hardware — use `varity_agent_info <name>` to see current monthly cost. Each agent also has a small set of required environment variables (e.g. a Telegram bot token, an API key) that the AI editor will prompt you for.

## End-to-end example

From empty folder to deployed app, all in natural language:

```
You: "Make me a simple landing page for my coffee shop and deploy it"
AI:  Scaffolded a Next.js app, edited the home page, ran the build,
     deployed live at https://varity.app/coffee-shop/

You: "Now deploy a Telegram bot I can chat with"
AI:  Need three things: an OpenAI API key, a Telegram bot token (get
     one from @BotFather), and your Telegram user ID.
You: (provides them)
AI:  Deployed hermes agent at https://varity.app/my-bot/
     Send a message to your bot on Telegram to chat with it.
```

## How Varity is priced

- **Flat monthly cost per app**: locked at deploy time, based on the hardware your app reserves. Your bill on day 1 equals your bill on day 1000.
- **No usage-based billing**: cost doesn't change with traffic, requests, bandwidth, or build minutes. No surprise overages.
- **No plan tiers**: every feature is in every account; you don't pay for "Pro" to unlock anything.

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

Hosted at `https://mcp.varity.so` — connect directly from any HTTP-capable MCP client.

## Prerequisites

- **Node.js** >= 18
- **For deployment**: `pip install varitykit`

## Cost

Varity charges a flat monthly price per app, locked at deploy time based on the hardware reserved. Your bill doesn't grow with your traffic, requests, or build minutes. Use the `varity_cost_calculator` tool from your AI editor for a detailed estimate before you deploy.

---

**Deploy any app from your AI coding tool.** Flat predictable pricing — your bill stays the same as your app grows.

[Documentation](https://docs.varity.so/ai-tools/mcp-server-spec) · [GitHub](https://github.com/varity-labs/varity-mcp) · [Discord](https://discord.gg/7vWsdwa2Bg)
