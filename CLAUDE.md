# CLAUDE.md — varity-mcp-standalone

## What this repo is
**The CANONICAL home of `@varity-labs/mcp`** — the thin MCP server that shells to `varitykit`. Develop MCP changes HERE, then sync them into the mirror at `../varity-sdk-private/packages/cli/varity-mcp/` (keep both aligned, at least for now). Publishes to npm via `varity-labs/varity-mcp`. **Public repo.**

## What Varity is (don't drift from this)
**Predictable-price cloud platform.** Bill on day 1 = bill on day 1000. Usage-metered cloud platforms scale their bills 5-40× with traffic; Varity charges for hardware reserved on a decentralized compute network, so cost is structural and flat. The wedge = **COGS predictability at scale** (structural moat — competitors' COGS floor is AWS). **For anyone deploying anything (non-coders, developers, businesses); never pre-filter the audience in copy.** GTM = product-led growth, B2C-first with B2B in parallel. Internal GTM segmentation (NOT headline copy): solopreneurs, indie hackers, agencies, bootstrapped startups, AI agent builders; vibe coders/non-coders are top-of-funnel via the free static tier. Internally a **DePIN orchestration protocol** that abstracts ALL blockchain complexity — NEVER user-facing. Product = exactly 2 packages: `varitykit` (PyPI) + this MCP. The MCP is a thin wrapper; the orchestration runs in `varitykit`/the gateway, never here.

**Brand-voice rule:** declarative positioning, NOT comparative. Don't name competitors (Vercel/Render/Railway/etc.) in user-facing surfaces — frame the moat as "usage-based billing vs flat hardware-reserved." Competitor names are fine internally (this file, architecture docs, investor materials) and in operational features (`varitykit migrate` is explicitly Vercel-migration).

## Canonical sources (the truth; read in order)
1. `../CLAUDE.md` — workspace scope + in-scope/ignore repo map
2. `../POSITIONING.md` — voice, persona, forbidden vocabulary (applies to ALL tool descriptions + responses)
3. `../PRICING-MODEL-CANONICAL.md` — the ONLY authority for cost claims (the `varity_cost_calculator` tool calls the gateway `/api/pricing`; copy must match)
4. `../varity.manifest.yaml` — structured truth

## Facts (verified 2026-05-20)
- Published: `2.0.0-beta.23` on npm (`latest` + `beta`). **18 tools** (not 16 — older docs say 16).
- Bump-both when publishing: `package.json` version AND `src/server.ts` `VERSION` const.

## Known stale content to fix
- README / tool descriptions mentioning "16 tools", SDK/blockchain, "cheaper than AWS", or `varity_init` as a promoted beta path → correct/remove.
- Any reference to the retired `varity-labs/varity-sdk` monorepo or `sync-to-public.sh`.

## Guardrails
- Zero blockchain UX in tool descriptions or responses (no addresses, hashes, chain IDs, AKT/USDC).
- Never claim a tool not actually registered in `src/server.ts`.
- Never let responses leak ANSI codes, raw stack traces, or platform-specific paths.
- Cost copy: fixed-hardware framing, vs Vercel/Render/Railway, cite `PRICING-MODEL-CANONICAL.md`.
