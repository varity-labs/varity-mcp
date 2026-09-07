# Domain docs

The stdio package is active; hosted MCP is retired under engineering:CLAUDE.md. Retained HTTP code does not authorize reactivating the hosted offering.

Use the existing `ARCHITECTURE.md` ownership map and the code routes below.
Cross-repository decisions: `engineering:architecture/DECISIONS.md`; topology: `engineering:architecture/likec4/`. Resolve repository IDs through `engineering:repos.yaml`.

- `src/index.ts`: stdio entrypoint.
- `src/server.ts`: tool registration and transport allowlist.
- `src/utils/cli-bridge.ts`: varitykit mutation adapter.
- `src/utils/public-api.ts`: owner-scoped public read adapter.
- `src/utils/responses.ts`: shared tool-result interface.

If `CONTEXT.md` or `CONTEXT-MAP.md` exists, read relevant terms and use its vocabulary. Missing glossaries are not defects: continue without scaffolding them. Record only resolved domain terms lazily, keep implementation in code, reuse existing decision locations, and surface conflicts with accepted decisions explicitly.
