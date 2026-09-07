# CLAUDE.md — `@varity-labs/mcp`

This repository is the canonical public source for the published Varity MCP
server. It is a thin client of the one Varity PaaS control plane. It must never
contain provider selection, deployment orchestration, durable deployment state,
billing policy, or a second embedded-consumption path.

## Read first

Cross-repository authority lives in the `varity-engineering` control
repository, checked out at `/home/macoding/varity-v2/varity-engineering/`
on this host. Read its `CLAUDE.md` for current scope and retirement rules:

1. `varity-engineering/CURRENT-STATE.md` for dated shipped, unfinished and
   blocker status, and `varity-engineering/repos.yaml` for repository topology.
2. [ARCHITECTURE.md](ARCHITECTURE.md) for this repository's transports, adapter
   seams, state, auth, failure semantics, and test surface.
3. `varity-engineering/POSITIONING.md` before editing tool descriptions or
   responses.
4. `varity-engineering/PRICING.md` before editing cost behavior.

Do not copy live backend versions, release history, gate status, or pricing into
this repository. `varity-engineering/CURRENT-STATE.md` and live probes own
operational truth.

## Actual runtime shape

- The published package serves MCP clients over stdio. Streamable HTTP
  implementation remains in source; hosted MCP is retired.
- Deployment mutations, template operations, login, and migration use the
  `varitykit` CLI adapter in `src/utils/cli-bridge.ts`.
- Deployment/status/log and pricing reads use the owner-scoped public Varity
  interface through `src/utils/public-api.ts`.
- Several developer tools operate directly on the MCP host's filesystem or
  processes; this is naturally the user's machine in stdio mode, but not in a
  hosted HTTP process.
- Hosted MCP and its OAuth offering are retired under control `CLAUDE.md`.
  Historical certification procedures in `ARCHITECTURE.md` do not authorize
  reactivation.
- The MCP never calls provider, static-storage, db-proxy, credential-proxy, or
  billing internals directly.

The older statement that every deploy operation shells to `varitykit` is too
broad. Preserve both real adapter seams unless a separately reviewed change
migrates callers and proves behavior through their interfaces.

## Commands

```bash
npm run build
npm test
npm run check:architecture
npm start
```

Publishing is a founder/release action. Keep `package.json` and
`src/server.ts` versions synchronized, then use the repository's publish
guard. Do not publish from an architecture-only branch.

## Change rules

- Keep tool results on the shared `successResponse` / `errorResponse` shape.
- Do not expose internal infrastructure or provider vocabulary in user-facing
  tool descriptions.
- Do not hardcode pricing; call the public pricing interface.
- Do not place credentials in arguments that are logged, responses, docs, or
  fixtures. Treat registry passwords, GitHub tokens, deploy keys, and OAuth
  tokens as secrets.
- Preserve stdio/HTTP differences deliberately. A local-filesystem tool is not
  automatically safe or meaningful in hosted HTTP mode.
- Do not present retired `mcp.varity.so` as an active hosted offering.
- Update `ARCHITECTURE.md` in the same change when ownership, an adapter
  interface, auth/custody, persistent or process-local state, transport
  topology, or failure semantics change.
- Complete the pull request's `Architecture impact` declaration. An internal
  implementation change behind unchanged interfaces may correctly declare
  `none`.

## Out of scope

- The frozen MCP mirror under `varity-sdk-private`.
- Dormant SDK, UI kit, types, create-app, SaaS-template, App Store, and
  blockchain-era code.
- Provider-specific orchestration or a separate path for embedded consumers.

## Agent skills

- GitHub Issues and shared operations: [issue tracker](docs/agents/issue-tracker.md).
- Canonical triage roles: [label mapping](docs/agents/triage-labels.md).
- Existing ownership maps, decisions and code: [domain routes](docs/agents/domain.md).
