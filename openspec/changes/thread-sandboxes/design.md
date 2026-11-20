# Design

## Context

- Server and runner are separate processes; runners connect outbound over the authenticated gRPC transport (`runner-grpc-transport`) and need no inbound port — any provider that allows outbound HTTPS can host a runner.
- Runner roles today: `general` / `dedicated` (`packages/server/src/services/runner-scope.ts`). `runner-resolver.ts` checks the pinned project, then thread → assigned → general candidates; a thread's `runnerId` is only a candidate, so an offline sandbox would fall through to the general runner — unacceptable here.
- Enrollment supports `RUNNER_INVITE_TOKEN` (per user, 30 days) and device link. The archived `provision-railway-runners` designed a provisioning token, infra connections, a provider interface and public-URL detection; none were implemented.
- First provider, Boat (docs.boat.dev, 2026-10): REST `https://boat.dev/api/v1`, `Authorization: Bearer boat_…`, SDK `@boatdev/sdk` (`create({ from, type, env, ttlSeconds, idempotencyKey })`, `get`, `stop`, `resume`, `update`, `deleteSandbox`, `command`, `saveSavedSnapshot`). Stop keeps the disk 14 days (`409 snapshot_data_expired` after), not memory; resume keeps the id, new IP. TTL auto-stop from create/resume (default 1 h, max 30 d). `--setup-file` runs once; services surviving resume need systemd. `~/.boat/pre-stop` runs before stop (60 s). Per-sandbox env: 100 vars / 64 KB. Plan $20: 100 concurrent, 12 starts/min, 60/h, 200/day. Templates are saved snapshots.

### Spike 1.1 results — Boat, part A (2026-10-31, `small`, no funny runner yet)

| Check                        | Result                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create → `ready`             | 0.9 s (with `Idempotency-Key`, `env`, `ttlSeconds`)                                                                                                                                                                                                                         |
| Base image                   | Ubuntu 24.04, kernel 6.8, user `user` with passwordless sudo, systemd 255; preinstalled git 2.43, Bun 1.3.14, Node 24, gh 2.97, Claude Code 2.1.316, codex 0.166, Docker 29.7, Python 3.12. `small` = 2 vCPU / ~4 GB / 79 GB disk                                           |
| Per-sandbox `env`            | Visible to commands, persists across stop/resume                                                                                                                                                                                                                            |
| Outbound to the funny server | HTTPS over HTTP/2 OK (connect 34 ms, TLS 48 ms, total 158 ms); outbound IPv6                                                                                                                                                                                                |
| Idle TLS connection          | Still open after 150 s idle (no reset); a 30 min gRPC soak remains for part B                                                                                                                                                                                               |
| Stop → `archived`            | 7.5 s; disk kept (`~/work/marker` survived)                                                                                                                                                                                                                                 |
| Resume → `ready`             | 0.9 s; same outbound IP observed (docs say it may change)                                                                                                                                                                                                                   |
| `~/.boat/`                   | Absent by default; the template must create `~/.boat/pre-stop`                                                                                                                                                                                                              |
| Billing                      | `small` multiplier 0.5: 78 s billed US$0.00078                                                                                                                                                                                                                              |
| Account gating               | Trial accounts get `402 billing_required` on create until the plan starts; then trial limits (2 active, 5/min, 25/h, 75/day, auto-stop ≤ 2 h). The adapter maps `billing_required` → non-retryable `quota` with an actionable message and reads `GET /limits` on `validate` |

**Public gRPC endpoint probe (task 1.0, 2026-10-31):**

- Railway HTTP service domain targeting `:50051` → `502 Application failed to respond` (edge `railway-hikari` forwards HTTP/1.1 upstream; the h2c gRPC listener cannot be served through it). Domain deleted.
- Railway TCP proxy to `:50051` → h2c gRPC reaches the listener from the internet AND from a Boat sandbox: `grpc-status: 16 runner credentials required`. Proxy deleted afterwards because it was plaintext.
- Decision (2026-10-31, user: "zero configuration"): no public gRPC port. Runners outside the private network use a **WebSocket carrier** on the existing HTTPS origin (D13).

### 13. WebSocket carrier for runner gRPC (zero configuration)

The server accepts `wss://<origin>/api/runner-grpc/ws` in the same `Bun.serve` as the UI and pipes each WebSocket byte-for-byte to its private gRPC listener; the runner derives that URL from `TEAM_SERVER_URL` when `RUNNER_GRPC_ENDPOINT` is unset and bridges it to grpc-js through an ephemeral loopback port. `runner.v2`, authentication and limits are untouched; TLS comes from the HTTPS origin. Railway documents WebSockets as exempt from its 5/15-minute HTTP limits ("can stay open indefinitely, even while idle"). Verified locally with real grpc-js bidirectional streaming (metadata, a 3 MiB message) through carrier + bridge. _Alternatives_: TCP proxy + self-signed TLS with pinned fingerprint (works, but a random non-443 port, certificate code and a proxy to create); custom domain + ACME (needs DNS); plaintext TCP proxy (rejected: token exposure); server dialing sandboxes (rejected: inbound exposure per sandbox).

### Spike 1.1 results — part B: a real runner in Boat (2026-10-31)

- Runner (this branch) started in a `default` Boat sandbox with only `TEAM_SERVER_URL`; enrolled via device link (approved by the user) and opened its gRPC session through the WebSocket carrier in 487 ms. Sandbox creation → install (`bun install`, 2676 packages, 22 s) → waiting for approval: 53 s.
- 30-minute soak (20:25 → 20:55 UTC): zero disconnects or reconnects.
- Stop → archived 2.7 s; resume → ready 0.7 s; runner credentials survived on disk; the runner resumed from them as the SAME runner in 2.8 s (total resume → runner online 3.8 s).
- Template build check (live): the provider-neutral install script cloned `ironmussa/funny` at a commit and installed on a real sandbox (~26 s); saving the snapshot is refused on the free trial (`403 trial_saved_snapshots_not_allowed`), which the template manager now treats as "templates unavailable" → on-the-fly install.

## Goals / Non-Goals

**Goals:** one sandbox per thread; a provider contract where adding a provider touches only its adapter + template recipe; strict routing to the thread's runner; wake on demand and idle stop; code always recoverable from the remote branch.

**Non-Goals:** implementing providers other than Boat (the contract must accommodate them, see D2); scratch threads in sandboxes; per-project shared sandboxes; preserving process memory across stop; restoring ignored/local-only files after loss; provider-native agents (`boat prompt`); provider AI proxies in v1 (D10); fork-a-sandbox UX.

## Decisions

### 1. Layering — the provider is the only provider-aware code

```
packages/server/src/services/thread-sandboxes/
  contract.ts          SandboxProvider, SandboxCapabilities, NormalizedState, SandboxError (pure types)
  registry.ts          createSandboxProviderRegistry(entries): list / has / instantiate (validates config)
  provider-catalog.ts  the ONLY production list of registered provider entries
  lifecycle.ts         ThreadSandboxService: provision / wake / idle-stop / recover / destroy (Effect)
  sweeper.ts           idle stop + startup reconciliation
  providers/
    fake/              in-memory provider, used by unit tests + contract suite
    boat/              adapter over @boatdev/sdk
  __tests__/provider-contract.ts   shared suite: run(providerUnderTest)
scripts/sandbox-templates/
  install-runner.sh    provider-neutral: Bun, git, gh, runner@version, agent CLIs, service unit
  boat/build.ts        boots a Boat sandbox, runs install-runner.sh, saves snapshot
```

Routing, scope, lifecycle, backup, runtime and client never import from `providers/*`. `__tests__/services/thread-sandboxes/provider-imports.test.ts` fails on any production import of `thread-sandboxes/providers/` outside `providers/` itself and `provider-catalog.ts`; tests are exempt.

### 2. Provider contract

```ts
interface SandboxProvider {
  readonly id: string;                         // 'boat', 'e2b', 'daytona', 'fly', …
  capabilities(): SandboxCapabilities;
  validate(cred): ResultAsync<{ accountLabel: string }, SandboxError>;
  create(req: { threadId; size; template: TemplateRef; env: Record<string,string>;
                lifetimeMs?: number; idempotencyKey }): ResultAsync<SandboxHandle, SandboxError>;
  status(h): ResultAsync<{ state: NormalizedState; providerState: string; detail? }, SandboxError>;
  stop(h): ResultAsync<void, SandboxError>;      // only if capabilities.stopPreservesDisk
  resume(h, { lifetimeMs? }): ResultAsync<void, SandboxError>;
  extendLifetime?(h, ms): ResultAsync<void, SandboxError>;
  destroy(h): ResultAsync<void, SandboxError>;
  resolveTemplate(serverVersion): ResultAsync<TemplateRef, SandboxError>;
}

interface SandboxCapabilities {
  stopPreservesDisk: boolean;     // Boat: true; ephemeral providers: false
  stoppedRetentionMs: number | null;  // Boat: 14 d
  maxLifetimeMs: number | null;   // provider-side cap support (Boat: 30 d)
  sizes: { id: string; vcpu: number; memoryGb: number; default?: boolean }[];
  env: { maxVars: number; maxBytes: number };
  preStopHook: 'native' | 'none'; // Boat: native (~/.boat/pre-stop)
}

type SandboxError =
  | { kind: 'auth' } | { kind: 'not-found' } | { kind: 'expired' }
  | { kind: 'quota'; retryable: false } | { kind: 'rate-limited'; retryAfterMs?: number }
  | { kind: 'unavailable'; retryAfterMs?: number } | { kind: 'template-missing' }
  | { kind: 'provider'; message: string };
```

Lifecycle decisions read only capabilities and normalized errors: no disk-preserving stop → idle means destroy-after-backup and wake means recover (D11); `maxLifetimeMs` null → server sweeper is the only cap; `expired`/`not-found` → recovery; `unavailable`/`rate-limited` with `retryAfterMs` → retry; `quota` → user-facing error. Nothing is passed in env except the enrollment bootstrap (D6), so env limits only bound that. _Alternative_: one generic adapter configured per provider — rejected, provider APIs differ too much; a typed contract + shared contract suite gives the same guarantee.

### 3. Connections and registry

`infra_connections(id, user_id, provider, label, config_json, credential_enc, created_at, last_validated_at)`. The registry entry provides a zod `configSchema` (Boat: `{ environmentId? }`) and credential shape; the server validates both, encrypts the credential with `lib/crypto.ts` and never returns it. The client renders the provider list and size choices from `GET /api/infra/providers` (registry metadata + capabilities), so a new provider needs no client change beyond optional i18n strings.

### 4. Role `sandbox` + table `thread_sandboxes`

`thread_sandboxes(thread_id PK, connection_id, provider, provider_handle, runner_id, size, state, backup_state, last_activity_at, running_ms, error, generation)`. `runners.role` accepts `sandbox`; a sandbox runner stores `thread_id`. `runner-scope.ts` adds `canRunnerAccessThread(runnerId, threadId)`; `evaluateRunnerAccess` returns `false` for `sandbox` runners on project-level and projectless targets; `data-scope.ts` uses the thread predicate. _Alternative_: `dedicated` + per-thread project pin — rejected: a dedicated runner serves every thread of its project.

### 5. Resolver precedence

In `resolveRunnerDetailed`, before the pinned-project branch: a thread with a `thread_sandboxes` row has exactly one candidate, its runner. Unreachable → reason `thread-sandbox-unavailable` (+ state). The proxy turns that into wake-then-retry for wake-able routes (D7) and 409 with state otherwise. `withRunnerFor` still certifies the owner's runner; its scope step now consults `canRunnerAccessThread`.

### 6. Templates and enrollment env

The template is "a machine image with the runner installed as a restartable service, pinned to the server version", produced per provider by `scripts/sandbox-templates/<provider>/` from the shared `install-runner.sh`. `resolveTemplate(serverVersion)` returns the provider's ref (Boat: saved snapshot `funny-runner-<version>`); missing → `template-missing`. Create-time env is the same for every provider: `TEAM_SERVER_URL`, `RUNNER_PROVISION_TOKEN` (single-use, ≤ 1 h, bound to user+project+thread), `WS_TUNNEL_ONLY=true`, `FUNNY_DATA_DIR`. The runner persists its credential on the sandbox disk; git and agent credentials are delivered per operation by the server, never stored in the provider.

### 7. Lifecycle orchestration (Effect)

`ThreadSandboxService` drives create → status `running`-ready → runner enrolls → `thread:bootstrap` → agent start. Effect for bounded waits (ready ≤ 3 min, reconnect ≤ 2 min), retries only on `unavailable`/`rate-limited` with provider-given delay, interruption on thread delete (destroy registered as finalizer). `idempotencyKey = threadId:generation`. Wake: `resume` → await presence → replay the pending request; concurrent wakes per thread share one in-flight fiber.

### 8. Bootstrap

Control command `thread:bootstrap { threadId, repoUrl, baseRef, branch }`: clone into `~/work/<projectId>` with the per-operation git credential, `git switch -c funny/<threadId> <baseRef>`, `git push -u origin`, report path. From the runtime's view the thread is `local` in that checkout; the server-side thread gets `runtime: 'sandbox'`, so worktree logic is untouched.

### 9. Checkpoint backup

Separate from `universal-git-turn-checkpoints` (local rewind). On turn end: `git add -A` honoring `.gitignore`, unstage secret-denylist paths and files > 5 MB, commit `funny checkpoint: turn <n>` with the user's identity, push with backoff (max 5, then `failed`); `thread:backup` event. Pre-stop: `funny runner pre-stop` does a final best-effort push; providers with `preStopHook: 'native'` wire it in the template (Boat: `~/.boat/pre-stop`); others rely on the server, which never stops a sandbox whose backup is not `synced`.

### 10. Agent credentials

Server-delivered per operation (user provider keys; headless Claude token per profile as `CLAUDE_CODE_OAUTH_TOKEN`; profile `configDir` normalized to `~/…`). Provider AI proxies (e.g. Boat's, $1/day + requests, injects `ANTHROPIC_BASE_URL`) are not used in v1: they collide with per-operation env and are provider-specific. Could become an optional connection capability later.

### 11. Idle stop, lifetime cap, recovery

Runner reports activity (turn, permission prompt, PTY, running command) reusing the orchestrator `lastActivityAt` from `agent-idle-reaper`. Sweeper every 60 s: idle ≥ `FUNNY_SANDBOX_IDLE_MS` (10 min), nothing active, backup `synced` → `stop` if `stopPreservesDisk`, else `destroy` and mark `stopped-ephemeral`. Lifetime cap = 4 h when `maxLifetimeMs` is set, extended while active. Startup reconciliation lists `thread_sandboxes` in running states and stops/destroys idle ones, covering providers without a cap. Recovery on `expired`/`not-found` or ephemeral wake: `generation++`, create, bootstrap from `origin/funny/<threadId>`, cold-path context from DB, system notice.

### 12. Guardrails

`FUNNY_SANDBOX_MAX_RUNNING_PER_USER` (default 3) across all providers, checked atomically before create/resume. Size ids come from capabilities; default = the provider's `default` size (Boat `default`, 4 vCPU / 8 GB).

## Risks / Trade-offs

- [Server gRPC not publicly reachable today] → expose a TLS gRPC endpoint (spike 1.1 part B); every external provider depends on it. The runner has no WS fallback (gRPC-only transport).
- [Contract too shaped by Boat] → contract designed against two more providers on paper (task 2.7 maps E2B + Fly Machines onto it) before freezing; capabilities absorb differences.
- [Cold start latency 1–3 min] → templates, shallow clone, progress states; warm pools later behind the same contract.
- [Resume = new machine: dev servers and containers gone] → documented; only the runner service restarts.
- [Checkpoint may leak a secret outside the denylist] → denylist + size limit + warning; per-project opt-out (then stop asks for confirmation).
- [Cost runaway] → running cap, idle stop, lifetime cap, reconciliation, running time visible.
- [Template drift vs server version] → template ref embeds version; deploy runbook includes template build.

## Migration Plan

Additive tables and enum values (SQLite + PG). Feature hidden until a connection exists and a public server URL resolves. Rollback: disable sandbox mode; sandbox threads become read-only (history visible, code on the remote branch).
