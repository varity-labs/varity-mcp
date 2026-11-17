# `@varity-labs/mcp` Architecture

Status: current implementation map
Scope: stable ownership, interfaces, adapters, state, security, failures, and tests

This repository is the public stdio MCP adapter for Varity. Cross-repository
concept ownership is routed by `varity-engineering/architecture/CHANGE-IMPACT.md`;
source and tests here own the package's executable behavior. Live versions,
pricing, deployment state, and supported capability come from their executable
owners rather than copied prose.

## Ownership

This repository owns:

- the MCP tool, compatibility resource, and prompt interface presented to local
  AI coding clients;
- stdio process composition and JSON-RPC channel custody;
- translation from validated MCP inputs to the deploy-key-authenticated public
  Varity interface, or (migration preview only) a local `varitykit` command;
- consistent structured success/error responses;
- secret-safe telemetry through standard OpenTelemetry exporters and optional
  Better Stack error ingestion;
- bounded local helpers for builds, dependencies, browser opening, development
  servers, migration, and repository creation.

It does not own:

- a hosted or self-hosted network MCP transport, OAuth service, or container
  release;
- workload planning, hosting selection, deployment execution, route activation,
  cleanup, or remediation policy;
- durable deployment/release state, credentials, billing ledgers, profile
  catalogs, pricing policy, or copied deployment guidance;
- direct provider, static-storage, database-proxy, credential-proxy, or billing
  integrations.

## Context and call flow

```mermaid
flowchart LR
  CLIENT[Local MCP client] -->|stdio JSON-RPC| SERVER[MCP composition]
  SERVER --> TOOLS[Tools, resource router, prompts]
  TOOLS --> PUBLIC[Public-interface adapter] --> CONTROL[Varity public control plane]
  TOOLS --> CLI[CLI bridge] --> VK[varitykit migrate preview]
  TOOLS --> LOCAL[Local filesystem and processes]
  SERVER --> TELEMETRY[Secret-safe telemetry] --> OTLP[Configured OTLP/error endpoints]
```

Deployment-lifecycle mutations (deploy, template deploy, delete, redeploy) and
the template catalog reach the downstream control plane through the
public-interface client; only the migration preview runs `varitykit`. Local build, dependency, browser, development-server, and
repository helpers remain local adapters, as the routing table below records.
MCP output is a projection of downstream truth: process exit can prove command
acceptance, but only a durable run or owner-scoped status read can prove later
lifecycle state.

## Runtime modules and interfaces

| Module | Interface and invariant | Implementation | Verification |
|---|---|---|---|
| Entrypoint | stdio only; stdout contains JSON-RPC only; unknown/retired transport flags fail closed | `src/index.ts` | `test/runtime-version.mjs`, `test/logger-stdio-channel.mjs`, runtime matrix |
| MCP composition | one complete local surface; no transport-specific alternate registration | `src/server.ts` | `test/tool-annotations.mjs` plus package startup tests |
| Tools | Zod-validated input and shared structured responses; no provider or orchestration policy | `src/tools/` | per-adapter and regression tests under `test/` |
| Compatibility resource | `varity://deploy/reference` remains stable but routes mutable facts to live docs/tools | `src/resources/index.ts` | cleanup contract and architecture checks |
| CLI bridge | argv arrays, bounded timeouts/output, normalized environment; `varitykit` is invoked only by the migration preview | `src/utils/cli-bridge.ts` | `test/cli-bridge-env.mjs`, `test/migrate-custody.mjs` |
| Public-interface client | the one HTTP client for every Cloud read and lifecycle mutation (deploy, template catalog and deploy, delete, redeploy, env, run status, machines); deploy-key auth in the order `VARITY_DEPLOY_KEY`, `~/.varitykit/config.json`, `VARITY_API_KEY` (`src/utils/config.ts`); `User-Agent: varity-mcp/<version> (<client>/<client version>; transport=stdio)` from the client's `initialize` identity, bounded to `[A-Za-z0-9._-]{1,64}` tokens; `source: "mcp"` on create; a per-call `Idempotency-Key` on deploy, template deploy and redeploy; bounded timeout, normalized errors; no copied pricing or lifecycle state | `src/utils/public-api.ts` | `test/public-api-client.mjs`, `test/idempotent-create.mjs`, `test/client-attribution.mjs`, `test/deploy-key-resolution.mjs`, `test/public-api-budget.mjs`, `test/lifecycle-outcomes.mjs`, `test/billing-refusals.mjs`, `test/agent-journey-contract.mjs`, status/log tests |
| Local GitHub helper | credentials come from process environment or `gh`; clean remote URL; normal non-force push | `src/tools/create-repo.ts` | cleanup contract plus Git behavior review |
| Runtime telemetry | opt-in spans/logs/metrics/errors; protected inputs and stdout excluded | `src/telemetry.ts`, `src/runtime-shutdown.ts`, `src/utils/logger.ts` | telemetry, logger, and shutdown tests |

The CLI bridge and public-interface client are separate adapters because their
callers need different downstream interfaces: the migration preview transforms
a local checkout, which no public route does. Every tool advertises a title and
all four MCP hints (readOnly, destructive, idempotent, openWorld) explicitly;
`test/tool-annotations.mjs` holds the binding table.

## Tool routing

| Behavior | Current path | Qualification |
|---|---|---|
| Deploy source/public image | MCP tool → public-interface client → `POST /api/deployments` | The source is a repo URL (explicit or the project's `origin` remote) or an image; the control plane owns build and hosting policy |
| Delete and reapply | MCP tool → public-interface client → `DELETE`/`POST .../redeploy` | Status is the run's `public_status` from `GET /api/deployments/runs/:id`; no run or an unreadable run is `null` (unobserved) |
| CPU and GPU VMs (list/create/delete) | `src/tools/machines.ts` → public-interface client → `POST /api/pricing/machine-quote`, `POST`/`DELETE /api/machines` (Idempotency-Key) | Create needs the caller's SSH public key; delete polls `GET /api/machines/:id` until `billing.state` is `stopped` (≤ 600 s), an unread state stays `null` (unobserved); `gpu: true` selects GPU VMs (`virtual_machine`); GPU containers and bare metal are out of MCP scope |
| Template list/detail/deploy | MCP tool → public-interface client → `GET /api/templates`, `GET /api/templates/:id`, `POST /api/templates/:id/deploy` | Catalog, certification, hardware, and price fields are downstream-owned; a missing `pricing.monthlyUsd` is shown as unavailable; private or secret-bearing templates are refused before any deploy request |
| Migration preview | temporary clone → `varitykit migrate apply --dry-run` → exact cleanup | URL-based apply/deploy fails closed until transformed-source custody is explicit |
| Deployment list/status/logs | MCP tool → public-interface adapter | Owner-scoped response is authoritative for this client; the returned `id` is the served `operation_deployment_id` (the id `varity_deploy` returned) when present, else the row id; a URL the owner has not assigned is omitted, and month-to-date accrual under an unobserved `billing.state` is `"unavailable"`, never 0 |
| Cost estimate | MCP tool → public `GET /api/pricing?profile=` (carries the deploy key when one is configured, so the owner can price the caller's account; anonymous without one; a rejected key is the standard `invalid_api_key` refusal, never retried anonymously) or the owner-scoped deployment billing block | `ai-agent-gpu` (GPU containers) is refused without a request and filtered from a served `profile_unknown` menu; the served `billing_note` is stated verbatim; profile keys, currency, billing model, and values are returned by the live owner under their served field names; USD only, no other unit |
| Balance | `varity_balance` → deploy-key-authenticated public `GET /api/credits/balance` | The key selects its owner. Only available balance, authorization maximum and amount owed are projected as exact decimal USD strings. Compatibility field `reserved_usd` is the served authorization maximum, not funded backing; the tool does not infer backing or subtract it from available balance. Missing or malformed money and failed reads remain unavailable. No portal-session billing details are requested. |
| Docs search | MCP tool → public `llms-full.txt`/`llms.txt` | Five-minute process cache; stale entries are not served after expiry if refresh fails |
| Build, install, browser, dev server, repository creation | local process/filesystem adapters | Operate on the invoking user's machine and credentials |

## Transport, auth, and trust

The package has one transport: stdio. The MCP process runs under the invoking
user and may act on explicitly supplied local paths. Varity operations use the
deploy key resolved by `src/utils/config.ts`: env `VARITY_DEPLOY_KEY`, then the
CLI sign-in file `~/.varitykit/config.json` (`deploy_key`, then `api_key`), then
the legacy env `VARITY_API_KEY`, which the public AI Gateway docs use for the
inference key. `varity_doctor` reports which source supplied the key, never the
key.

**stdout is the JSON-RPC channel.** Diagnostics go to stderr through the
central logger or `console.error`. A single unrelated stdout byte can corrupt
the client protocol.

Hosted MCP, Streamable HTTP, OAuth proxying, sessions, request rate limits, the
runtime container, and GHCR release aliases are retired and absent. Reintroducing
a network transport is a cross-repository security/topology change, not an
alternate flag on this process.

`varity_create_repo` never accepts a credential as MCP input. It reads
`GITHUB_TOKEN`/`GH_TOKEN` or `gh auth token`, passes the credential to Git only
through ephemeral environment-backed configuration, pushes without changing
the caller's Git configuration, stages only the selected project path, and
never force-pushes. Its returned `repo_url` is the handoff to `varity_deploy`.

Telemetry is opt-in. Standard `OTEL_EXPORTER_OTLP_*` configuration controls
OTLP export and `BETTERSTACK_MCP_DSN` controls optional error capture. Telemetry
failure cannot replace a tool result or change transport behavior. Request
arguments, credentials, arbitrary paths, results, and unbounded identifiers are
excluded from telemetry attributes and error events.

## State and data

The MCP owns no durable deployment, release, pricing, or billing state.

| State | Location | Custody |
|---|---|---|
| Deploy key/config | environment or `~/.varitykit/config.json` | host-local secret; never return or log |
| GitHub credential | process environment or GitHub CLI | read for one operation; never place in MCP input, Git argv, or `.git/config` |
| Docs sections | process memory | expires after five minutes; refresh failure returns no stale authority |
| Local dev-server registry | `~/.varitykit/dev-servers.json` | host-local helper state, not platform truth |
| Telemetry buffers | process memory in OpenTelemetry SDKs | flushed on stdio close, signals, or fatal startup |
| Deployment/release/log/billing truth | downstream Varity control plane | read or mutated only through the two adapters above |

The compatibility resource contains only live-owner routes. It must not regain
copied prices, quotas, supported-stack lists, topology, availability promises,
or release state.

## Failure semantics

- CLI command failures return normalized stdout, stderr, and an exit code;
  tools convert that result into the shared MCP error shape.
- Deploy, template deploy and redeploy send an `Idempotency-Key` generated per
  call, never derived from the request. A 504 `deploy_acceptance_unconfirmed`
  is resent exactly once with the same key; any other failure, or a second
  504, is returned unchanged.
- Deployment-family success means command acceptance. Tools project only a
  valid durable run reference and an explicitly reported public URL; they never
  manufacture deployment IDs, terminal status, or liveness.
- Migration is preview-only for URL input. Its `finally` cleanup removes the
  exact temporary clone on every completion/failure path; apply/deploy requests
  fail closed with the user-controlled-checkout workflow.
- The public-interface adapter aborts bounded reads and preserves downstream
  code/message/action fields, except: a 402/503 whose code is one of the closed
  billing codes served in `credit_policy.errorCodes` (`GET /api/pricing`)
  keeps its code and gets MCP copy in USD wording (an unreadable list leaves
  the error unchanged); `invalid_api_key` gets the portal's "deploy key" term
  and its settings URL; and a served action naming a raw HTTP route is dropped
  so the tool's own tool-naming action applies. Transport failures become
  `VARITY_API_UNREACHABLE`.
- Every tool input is a strict object: an undeclared argument is refused with
  the tool's accepted argument names (`strictToolInputs` in `src/server.ts`).
- Public URL liveness probes are observations for the current status response;
  they do not mutate canonical deployment state.
- User-controlled values remain argv entries or encoded URL components, never
  shell fragments.
- Repository pushes are normal fast-forward-safe pushes. Divergence is an error
  for the user to inspect; the MCP never overwrites remote history.
- Telemetry failure emits a bounded stderr diagnostic and cannot change the MCP
  result. Shutdown retains telemetry custody even when transport close fails.

## Verification

Required checks:

```bash
npm run check:architecture
npm run build
npm test
git diff --check
```

CI runs the full build/test job on maintained Node 22 and executes the built stdio
entrypoint on maintained Node 22 and Node 24. CI installs the exact reviewed lock with npm audits disabled, including when the
environment enables audits. The runtime test verifies the MCP
initialize response reports the exact package version and that retired network
transport arguments fail closed.

Publication is a hand publish by the release owner; no workflow publishes the
package, so a tag push publishes nothing. From a fresh clone checked out at the
exact release commit: `node scripts/check-release-custody.cjs`, then
`npm ci --no-audit --no-fund && npm run build && npm test && npm pack --dry-run`,
then `npm publish`, then `mcp-publisher` for the MCP Registry.
`scripts/check-release-custody.cjs` reads the clean candidate's exact Git commit
and queries the matching remote `mcp-v<package version>` tag, including its
peeled target. An absent tag or a tag at the same source is allowed;
conflicting, malformed or unreadable tag custody refuses publication.
`test/release-custody.mjs` covers the guard, and `test/server-json.mjs` keeps
`server.json` versions equal to the package version. A hand publish carries no
npm provenance, so the GitHub Release records the npm `dist.integrity`.

High-value coverage includes CLI environment normalization, stderr-only logging,
public URL liveness classification, log completeness/freshness, lifecycle
acceptance semantics, public-interface timeout policy, telemetry correlation and
protected-input exclusion, real synthetic OTLP construction, shutdown flushing,
and tool annotation discovery. Missing behavior should be added behind the two
existing adapters rather than through a second implementation.

## Change navigation

- Tool schema/response change: update the owning `src/tools/*` module, public
  README surface, regression tests, and this map if semantics changed.
- CLI command/timeout/output change: update `src/utils/cli-bridge.ts` and adapter
  tests; keep command policy out of individual callers.
- Public route/auth/error change: update `src/utils/public-api.ts` and its
  contract tests with the owning public API/docs surfaces.
- Resource/prompt change: preserve stable MCP names while routing mutable facts
  to live owners.
- Transport, credential custody, telemetry, durable state, pricing policy, or
  orchestration change: update this map and route cross-repository impact through
  the control repository before implementation.
