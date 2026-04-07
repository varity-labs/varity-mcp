# @varity-labs/mcp

[![npm](https://img.shields.io/npm/v/@varity-labs/mcp)](https://www.npmjs.com/package/@varity-labs/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/varity-labs/varity-sdk/blob/main/LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-yellow.svg)](https://github.com/varity-labs/varity-mcp)

> Build, deploy, and monetize production apps from any AI coding tool — Cursor, Claude Code, VS Code, ChatGPT, Windsurf, OpenClaw, and more.

The Varity MCP Server is a full development engine for AI editors. It provides SDK knowledge, development tools, and deployment automation — so your AI can build complete apps with auth, database, and hosting auto-configured. Zero terminal commands required.

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

### Windsurf / OpenClaw / Any MCP client

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

## What's Included

### 5 SDK Resources

Your AI gets complete knowledge of the Varity SDK — no searching, no guessing:

| Resource | Content |
|----------|---------|
| `varity://sdk/database` | Collection CRUD API, QueryOptions, Document types, React hook patterns |
| `varity://sdk/auth` | PrivyStack, usePrivy, ProtectedRoute, LoginButton, provider setup |
| `varity://sdk/ui-components` | 52+ components with props, types, and usage examples |
| `varity://sdk/patterns` | Canonical app patterns — file structure, CRUD pages, auth wrapping |
| `varity://sdk/deploy` | Deployment reference, App Store submission, revenue split |

### 14 Tools

| Tool | Description | Transport |
|------|-------------|-----------|
| **Development** | | |
| `varity_init` | Create a new app (auto-installs dependencies) | stdio |
| `varity_install_deps` | Install npm packages | stdio |
| `varity_add_collection` | Add database collection with types, accessor, hook, and optional page | stdio |
| `varity_build` | Build for production | stdio |
| `varity_dev_server` | Start/stop local dev server | stdio |
| `varity_open_browser` | Open URL in default browser | stdio |
| **Deployment** | | |
| `varity_deploy` | Deploy to production (auto-builds first) | all |
| `varity_deploy_status` | Check deployment status | all |
| `varity_deploy_logs` | View build logs | all |
| `varity_submit_to_store` | Submit to Varity App Store | all |
| `varity_create_repo` | Create GitHub repo with template | all |
| **Info** | | |
| `varity_doctor` | Check environment prerequisites | all |
| `varity_search_docs` | Search tutorials and guides | all |
| `varity_cost_calculator` | Compare costs vs AWS/Vercel | all |

### 3 Workflow Prompts

| Prompt | What it does |
|--------|-------------|
| `build-app` | Full workflow: scaffold → add collections → build pages → deploy |
| `add-feature` | Add a feature to an existing app |
| `deploy-and-monetize` | Build → deploy → submit to App Store |

## End-to-End Workflow

Describe what you want. The AI handles everything:

```
You: "Build me a client invoice tracker"
AI:  ✅ Scaffolded project with auth, database, dashboard
     ✅ Added invoices collection with types, hook, and CRUD page
     ✅ Built and deployed to https://invoice-tracker.varity.app
     ✅ Submitted to App Store at $49/month (you earn $44.10/user)
```

No terminal commands. No configuration. No DevOps.

## What Makes This Different

| | Traditional MCP | Varity MCP |
|---|---|---|
| AI knows the SDK | Searches docs | Full API reference always in context |
| Create apps | Scaffold only | Scaffold + auto-install deps |
| Database setup | Manual | `varity_add_collection` — types, hook, page |
| Build | Manual `npm run build` | `varity_build` tool |
| Deploy | Manual commands | `varity_deploy` (auto-builds first) |
| Auth | Configure yourself | Zero-config, auto-injected |
| Cost | AWS/Vercel pricing | ~70% cheaper |
| Monetize | Not possible | 90/10 revenue split via App Store |

## Prerequisites

- **Node.js** >= 18
- **For deployment**: `pip install varitykit` + `varitykit login`

## Cost

Varity is ~70% cheaper than AWS/Vercel. Auth and database are included at no extra cost. Use the `varity_cost_calculator` tool for detailed estimates.

---

**Part of the [Varity SDK](https://github.com/varity-labs/varity-sdk)** — Build, deploy, and monetize apps 70% cheaper than AWS.

[Documentation](https://docs.varity.so/ai-tools/mcp-server-spec) · [GitHub](https://github.com/varity-labs/varity-mcp) · [Discord](https://discord.gg/7vWsdwa2Bg)
