# Varity MCP Server

> **Deploy any Node or Python app, AI agent, or LLM straight from your AI coding tool — one command, live in 60 seconds.**

[![npm](https://img.shields.io/npm/v/@varity-labs/mcp/beta?label=npm)](https://www.npmjs.com/package/@varity-labs/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/7vWsdwa2Bg)

`@varity-labs/mcp` is the [Model Context Protocol](https://modelcontextprotocol.io) server for [Varity](https://www.varity.so). It gives AI coding tools — **Claude Code, Cursor, Codex, Windsurf** — the tools to scaffold, build, and deploy your app for you. Ask your editor to ship your project and it goes from local code to a live URL, with the database and backend services it needs wired automatically.

Varity is a fixed monthly cost per app, **60-80% cheaper than Vercel, Render, or Railway** — your bill does not change with traffic.

## Install

Add the server to your AI tool's MCP config:

```json
{
  "mcpServers": {
    "varity": {
      "command": "npx",
      "args": ["-y", "@varity-labs/mcp@beta"]
    }
  }
}
```

- **Claude Code:** `claude mcp add varity -- npx -y @varity-labs/mcp@beta`
- **Cursor / Windsurf / Codex:** add the JSON above to your MCP settings.

Then ask your editor: *"Deploy this app with Varity."*

## What you can do

Once connected, your AI tool can:

- **Deploy your code** — `varitykit app deploy` equivalent, one step, returns a live URL
- **Estimate cost** before you ship, with the built-in calculator
- **Migrate from Vercel** in seconds
- **Deploy curated AI agent templates** with one command
- **Scaffold, build, and run** projects locally

## Tool surface

The public server exposes these tools (stdio transport):

| Group | Tools |
|-------|-------|
| Discovery | `varity_search_docs`, `varity_cost_calculator`, `varity_doctor` |
| Scaffold & setup | `varity_init`, `varity_install_deps`, `varity_build`, `varity_login` |
| Deploy your code | `varity_deploy`, `varity_deploy_status`, `varity_deploy_logs`, `varity_delete_deployment`, `varity_create_repo`, `varity_migrate` |
| AI agent templates | `varity_list_agents`, `varity_agent_info`, `varity_deploy_agent` |
| Local dev (stdio only) | `varity_open_browser`, `varity_dev_server` |

Full reference: **[docs.varity.so/ai-tools/mcp-server-spec](https://docs.varity.so/ai-tools/mcp-server-spec)**.

## Supported frameworks

Node.js (Next.js, React, Vue, Astro, Qwik, Vite SPA, Express, Fastify, NestJS, Koa, Hono), Python (FastAPI, Django, Flask), and static sites. Auto-wired backend services: Postgres (with pgvector), Redis, MongoDB, MySQL, and Ollama.

## Local development

```bash
npm install
npm run build      # compile to dist/
npm run dev        # run the server in watch mode
npm test           # vitest
```

## Links

- **Docs:** [docs.varity.so](https://docs.varity.so)
- **Discord:** [discord.gg/7vWsdwa2Bg](https://discord.gg/7vWsdwa2Bg)
- **X / Twitter:** [@VarityHQ](https://x.com/VarityHQ)
- **Website:** [varity.so](https://www.varity.so)

## License

MIT © [Varity Labs](https://www.varity.so). See [LICENSE](LICENSE).
