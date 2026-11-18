# CLAUDE.md — `@varity-labs/mcp`

This repository is the canonical public source for the published Varity MCP
server. It is a thin client of the one Varity PaaS control plane. It must never
contain provider selection, deployment orchestration, durable deployment state,
billing policy, or a second embedded-consumption path.

## Read first

Cross-repository authority lives in the `varity-engineering` control
repository, checked out at `/home/macoding/varity-v2/varity-engineering/`
on this host. Read its `CLAUDE.md` for current scope and retirement rules:

1. Control `architecture/CHANGE-IMPACT.md` for concept ownership and
   `repos.yaml` for repository topology. `CURRENT-STATE.md` is dated evidence only.
2. [ARCHITECTURE.md](ARCHITECTURE.md) for this repository's transports, adapter
   seams, state, auth, failure semantics, and test surface.
3. `varity-engineering/POSITIONING.md` before editing tool descriptions or
   responses.
4. `varity-engineering/PRICING.md` before editing cost behavior.

Do not copy live backend versions, release history, gate status, or pricing into
this repository. Executable owners, current remote defaults, exact deployed
refs, CI receipts, and fresh live evidence own those facts.

## Actual runtime shape

- The published package serves MCP clients over stdio only. Hosted MCP, its
  OAuth adapter, and its container release lane are retired and absent here.
- Deployment, template and machine reads and mutations (deploy, template
  catalog and deploy, delete, redeploy, logs, status, runs, machines) and
  pricing reads use the one owner-scoped public Varity client in
  `src/utils/public-api.ts`.
- Only the migration preview runs the `varitykit` CLI, through
  `src/utils/cli-bridge.ts`. When browser sign-in is switched on,
  `varity_login` signs in through the browser (or a device code) and saves the
  deploy key to `~/.varitykit/config.json`; until then it tells the user to add
  a deploy key to the editor's MCP settings;
  the key is read from `VARITY_DEPLOY_KEY`, that file, or the legacy
  `VARITY_API_KEY` (`src/utils/config.ts`); sign-in runs no CLI.
- Several developer tools operate directly on the MCP host's filesystem or
  processes; in stdio mode this is the invoking user's machine.
- The MCP never calls provider, static-storage, db-proxy, credential-proxy, or
  billing internals directly.

Keep new Cloud calls on the public client; the CLI bridge exists for the
local migration preview only.

## Commands

```bash
npm run build
npm test
npm run check:architecture
npm start
```

Publishing is a founder hand publish; no workflow publishes the package. Keep
`package.json` and `server.json` versions equal (`test/server-json.mjs`). The
release sequence is in [ARCHITECTURE.md](ARCHITECTURE.md#verification).

## Change rules

- Keep tool results on the shared `successResponse` / `errorResponse` shape.
- Do not expose internal infrastructure or provider vocabulary in user-facing
  tool descriptions.
- Do not hardcode pricing; call the public pricing interface.
- Do not place credentials in tool arguments, command arguments, logged values,
  responses, docs, or fixtures. Treat registry passwords, GitHub tokens, and
  deploy keys as secrets.
- Do not reintroduce a network transport or present retired `mcp.varity.so` as
  an active offering without a separately governed architecture change.
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
