# @varity-labs/mcp

[![npm](https://img.shields.io/npm/v/@varity-labs/mcp)](https://www.npmjs.com/package/@varity-labs/mcp)
[![License: see LICENSE](https://img.shields.io/badge/License-see%20LICENSE-blue.svg)](https://github.com/varity-labs/varity-mcp/blob/main/LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-yellow.svg)](https://github.com/varity-labs/varity-mcp)

> The published Varity MCP package for Cursor, Claude Code, VS Code, Windsurf, and other MCP clients.

This repository contains only `@varity-labs/mcp`, the npm MCP server. It is a thin client of Varity's public API; it is not the Python CLI, the portal, the dormant SDK, or an app-store package.

The Varity MCP Server lets a supported local AI coding client build, deploy, and manage supported apps in production for you.

Ask your AI to put your app online: you can see the cost before anything deploys, a static site is usually live in seconds, and your keys stay in your project's .env file, never in the chat.

**Quick start**: pick your editor below and run one command.

## Install

### One-click install

GitHub does not open editor links, so use the install buttons on the [Varity MCP docs page](https://docs.varity.so/ai-tools/mcp-server-spec/), or open the link for your editor from your browser's address bar:

```text
Cursor:          cursor://anysphere.cursor-deeplink/mcp/install?name=varity&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB2YXJpdHktbGFicy9tY3BAbGF0ZXN0Il19
VS Code:         vscode:mcp/install?%7B%22name%22%3A%22varity%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40varity-labs%2Fmcp%40latest%22%5D%7D
VS Code Insiders: vscode-insiders:mcp/install?%7B%22name%22%3A%22varity%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40varity-labs%2Fmcp%40latest%22%5D%7D
```

Each link installs `npx -y @varity-labs/mcp@latest` and carries no key: you connect your Varity account afterwards with `varity_login`.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "varity": {
      "command": "npx",
      "args": ["-y", "@varity-labs/mcp@latest"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add varity -- npx -y @varity-labs/mcp@latest
```

### VS Code with Copilot

1. Command Palette → **MCP: Add Server**
2. Select **Command (stdio)**
3. Command: `npx -y @varity-labs/mcp@latest`
4. Name: `Varity`

### Windsurf

Add to `mcp_config.json`:

```json
{
  "mcpServers": {
    "varity": {
      "command": "npx",
      "args": ["-y", "@varity-labs/mcp@latest"]
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
      "args": ["-y", "@varity-labs/mcp@latest"]
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
- "Why did my deployment fail?"
- "Show the runtime logs for my deployment"

**Preview a Vercel migration**
- "Preview what would change when migrating github.com/me/my-app"
- "Show me the Vercel-specific artifacts to replace"

**When your app is live**

Ask your agent to finish with one plain line: where the app is, what it can cost, and how to stop paying. It reads like this:

> Your app is live at `<live URL>`. It costs up to `<monthly maximum>`/month (monthly maximum). Traffic alone does not change an app's monthly price. To stop billing, ask me to delete it.

The URL comes from `varity_deploy_status` and the monthly maximum from `varity_cost_calculator` or `varity_template_info`. The traffic sentence applies to apps only; virtual machines are priced by the hour.

**Docs and pricing**
- "Search Varity docs for environment variables"
- "What is the current estimate for this pricing profile?"
- "What billing projection does my deployed app report?"

## Tools

| Tool | What it does |
|---|---|
| `varity_search_docs` | Search the Varity documentation |
| `varity_cost_calculator` | Project the live owner's monthly or hourly USD estimate without converting units; pre-deploy estimates need no sign-in |
| `varity_balance` | Read your available balance, the amount set aside for your running apps (`reserved_usd`) and the amount owed; the message rounds to cents and the data keeps the exact decimal USD strings; unavailable reads never become zero |
| `varity_doctor` | Check that your environment is ready to deploy |
| `varity_login` | Connect Varity: opens a browser tab where you confirm (or shows a short code on a machine without a browser); no key to copy, no restart |
| `varity_logout` | Sign this computer out: revokes the saved sign-in on Varity, then removes it |
| `varity_install_deps` | Install project dependencies |
| `varity_build` | Build the project |
| `varity_open_browser` | Open a URL locally |
| `varity_dev_server` | Start the local development server |
| `varity_create_repo` | Create a GitHub repository and push the project |
| `varity_deploy` | Deploy the current project to production |
| `varity_deploy_status` | Check the status of a deployment: the current step and time so far while it deploys, how long it took once live, and the last lines of the build error when a build failed |
| `varity_deploy_logs` | Read runtime logs |
| `varity_delete_deployment` | Request deletion; poll `varity_deploy_status` until it is deleted and billing is stopped |
| `varity_set_env` | Set an app's settings (such as API keys) from the project's own `.env` file: you name the settings, the values are read on your computer and never pass through chat. Your app restarts; restarting holds one more month's maximum for a few minutes, then releases it |
| `varity_domain_add` | Point your own domain at an app and get the exact DNS record to add at your registrar |
| `varity_domain_verify` | Check whether that DNS record is in place and the domain is live |
| `varity_domain_remove` | Stop serving an app at its custom domain (it keeps its Varity address) |
| `varity_redeploy` | Restart a deployed dynamic or container app from its last successful release at its saved commit; a static site cannot be restarted. To ship new commits, push and run `varity_deploy` again with the same app name |
| `varity_machines_list` | List your CPU and GPU virtual machines (optionally the CPU or, with `gpu`, GPU VM profile catalog) |
| `varity_machines_create` | Quote and create a CPU or (`gpu: true`) GPU virtual machine with your SSH public key |
| `varity_machines_delete` | Delete a CPU or GPU virtual machine and confirm its billing stopped |
| `varity_list_templates` | List certified gateway-owned Varity templates |
| `varity_template_info` | Show full details for one certified template |
| `varity_deploy_template` | Deploy a public certified template; a template's required settings are read from your project's `.env` file, never typed into chat; private templates are refused |
| `varity_list_agents` | Backward-compatible alias for `varity_list_templates` |
| `varity_agent_info` | Backward-compatible alias for `varity_template_info` |
| `varity_deploy_agent` | Backward-compatible alias for `varity_deploy_template` |
| `varity_migrate` | Preview Vercel-to-Varity source transformations without mutating or deploying |

## Templates

Varity templates come from the gateway-owned certified catalog. Ask your AI editor "what templates can I deploy?" and it will list the live catalog and inspect each template contract. The MCP deploy tool supports public templates; when a template needs settings (for example an API key), put them in a `.env` file in your project folder and the tool reads them there, so the values never pass through chat. Private templates are refused.

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
npx -y @varity-labs/mcp@latest
```

The former hosted endpoint and network transport are retired. Browser clients
that require a remote MCP URL are not supported by this package.

## Prerequisites

- **Node.js** >= 22.11 (the current supported LTS baseline; EOL Node 18/20 are unsupported)
- **A Varity sign-in** for deploys and account reads. Ask your AI assistant to
  connect Varity: `varity_login` opens a browser tab, you confirm, and the
  sign-in is saved on this computer (`~/.varitykit/config.json`, readable only
  by you). No key to copy and no restart. Never put a key in chat.
  For CI or scripts, create a deploy key at
  https://developer.store.varity.so/dashboard/settings?tab=api-keys and set it
  as `VARITY_DEPLOY_KEY` in the MCP server environment.
  The key is read in this order: `VARITY_DEPLOY_KEY`, then the sign-in file
  `~/.varitykit/config.json`, then the legacy `VARITY_API_KEY`.
  `varity_doctor` reports which source supplied it.
- **varitykit** (`pipx install varitykit`) only for `varity_migrate`

---

**Deploy supported apps from your AI coding tool.**

[Documentation](https://docs.varity.so/ai-tools/mcp-server-spec) · [GitHub](https://github.com/varity-labs/varity-mcp) · [Discord](https://discord.gg/7vWsdwa2Bg)
