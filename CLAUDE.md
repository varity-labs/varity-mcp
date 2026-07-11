# CLAUDE.md — varity-mcp-standalone

The CANONICAL home of **`@varity-labs/mcp`** (npm, public repo) — the thin MCP server that shells to `varitykit`. Same engine, no second implementation; the orchestration lives in `varitykit` / the gateway, never here.

## STATUS (verified 2026-06-24)
Live and published to npm (`latest`). Develop MCP changes HERE only. Do not sync into the frozen in-repo mirror at `../varity-sdk-private/packages/cli/varity-mcp/`; that mirror is unmaintained and out of product scope. For the published version + tool count, see the manifest `product.packages."@varity-labs/mcp"` (do not restate here).

## WIRES IN
- **Downstream (this calls):** shells `varitykit` for every deploy operation; `varity_cost_calculator` hits the gateway `/api/pricing`. It does NOT talk to Akash/IPFS/db-proxy directly — those are reached only through `varitykit` / the gateway.
- **Upstream (calls this):** AI coding tools — Claude Code / Cursor / Codex — via MCP (stdio + HTTP transport).
- **Where it sits in the architecture:** one of the **two** products (`varitykit` + this MCP) and the secondary distribution channel (MCP-in-AI-IDE; the Developer Portal is primary PLG). It is a thin client over the same deploy engine, so it inherits the honest deploy surface and feeds the same deployment telemetry / orchestration path.
- **One-PaaS invariant:** direct portal/API/CLI/MCP use and embedded-platform use share this same public control plane and canonical deployment truth. Internal Layer 1/Layer 2 labels mean direct/embedded consumption only, not separate products, engines, workload classes, or roadmaps. This MCP must never implement an embedded-only path or orchestration policy.
- Exact backend versions / DSEQs / health (gateway, deploy-api, etc.): `../varity.manifest.yaml` → `state.services`. Never hardcode them here.

## SOURCE OF TRUTH
- `../varity.manifest.yaml` — versions, scope, capability, services registry (wins on operational conflict).
- `../CLAUDE.md` — workspace scope + in-scope/ignore map + guardrails.
- `../POSITIONING.md` — voice + forbidden vocabulary (applies to every tool description and response).
- `../PRICING-MODEL-CANONICAL.md` — the only authority for cost claims (the cost-calculator tool must match).

## Repo-specific operational facts
- Build: `npm run build` (tsc). Dev: `npm run dev` (tsc --watch). HTTP transport: `npm run start:http` (port 3100).
- Bin: `varity-mcp` → `dist/index.js`.
- Publish (founder action): bump BOTH `package.json` version AND `src/server.ts` `VERSION`, then `npm publish --access public` for the stable `latest` release. Use `--tag beta` only for an intentional prerelease.

## IGNORE-HERE (dormant / out of scope)
- Any tool/description referencing the App Store / submit-to-store, the SDK / ui-kit / types, `create-varity-app`, or SaaS-template scaffolding — dormant `sdk_pre_investment`, not the product, never promoted to users.
- Any blockchain/crypto/DePIN/wallet/AKT/USDC vocabulary in tool descriptions or responses — forbidden user-facing.
- The retired `varity-labs/varity-sdk` open-source monorepo and `sync-to-public.sh` — the public MCP ships from THIS repo, not there.
