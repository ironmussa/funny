# Tasks

## 1. Spikes (blocking)

- [x] 1.0a Probe public gRPC exposure on Railway: HTTP domain fails (502, HTTP/1.1 upstream); TCP proxy reaches the listener from internet and Boat (`grpc-status 16`); temporary resources removed
- [x] 1.0b Server: WebSocket carrier `RUNNER_GRPC_WS_PATH` → private gRPC listener (bounded buffers, connection cap, metrics); verify carrier tests with real sockets
- [x] 1.0c Runtime: derive `wss://…/api/runner-grpc/ws` from `TEAM_SERVER_URL` when `RUNNER_GRPC_ENDPOINT` is unset + loopback bridge for grpc-js; verify bridge/endpoint tests and a real grpc-js e2e through carrier + bridge
- [x] 1.0d Deploy server + runner to Railway (runner keeps its private `RUNNER_GRPC_ENDPOINT`); verified 2026-10-31: in-Railway runner reconnected privately, unauthenticated gRPC Control through `wss://…/api/runner-grpc/ws` from outside Railway → `16 runner credentials required` (457 ms), HTTP/2 SETTINGS through the carrier from a Boat sandbox (330 ms). Full runner enrollment from Boat is part of 1.1 part B
- [x] 1.1 Boat connectivity spike (part A done 2026-10-31, see design.md; part B = runner enrollment + 30 min soak, blocked on 1.0) (repeat per future provider): create a sandbox with a Boat API key, run the current runner with `TEAM_SERVER_URL` pointing at the Railway server, confirm gRPC session stays up ≥ 30 min, survives stop/resume (same runner id via persisted credentials), and measure create→online and resume→online latency; record results and exact SDK calls in design.md
- [x] 1.2 Template spike: build a saved snapshot with Bun, git, gh, claude/codex CLIs and a `funny-runner.service` systemd unit; verify the runner starts on create-from-snapshot and on resume; record size and boot time

## 2. Shared foundation (moved from provision-railway-runners)

- [x] 2.1 Schema (SQLite + PG) — `runners.thread_id` + role `sandbox` done (migration 082); `runner_provision_tokens` done (083); remaining: `infra_connections`, `runner_provision_tokens` (with nullable `thread_id`), `thread_sandboxes`, `runners.role` accepts `sandbox` + `runners.thread_id`, `threads.runtime`; verify migration tests on both dialects
- [x] 2.2 Infra connection service: encrypted credential via `lib/crypto.ts`, never returned, redacted in logs, audited use; routes CRUD/test with ownership checks; verify tests incl. redaction
- [ ] 2.3 Provisioning token issue/consume (hashed, single-use, ≤1 h, bound to user+project+thread) in the register path creating a `sandbox` runner; verify tests for success, replay, expiry, wrong thread
- [x] 2.4 Runtime: send `X-Runner-Provision-Token` from `RUNNER_PROVISION_TOKEN`, persist credentials, reconnect with them on restart; verify enrollment-client tests
- [x] 2.5 Public server URL resolution (`FUNNY_PUBLIC_URL` → `RAILWAY_PUBLIC_DOMAIN` → non-private origin) + self health-check + `remoteRunnersUnavailable`; verify unit tests incl. loopback rejection
- [x] 2.6 Provider contract (`SandboxProvider`, `SandboxCapabilities`, normalized states/errors), registry with config schemas, fake in-memory provider and the shared provider contract test suite; verify the fake passes the suite
- [ ] 2.7 Paper-check the contract against E2B and Fly Machines APIs (create/stop/resume/lifetime/templates); record the mapping in design.md and adjust capabilities before freezing
- [x] 2.8 Isolation test: no imports of `thread-sandboxes/providers/` outside `providers/` and `provider-catalog.ts`; verify the test catches a violation

## 3. Isolation

- [x] 3.1 `runner-scope.ts`: `canRunnerAccessThread`; `sandbox` runners denied for project-level and projectless targets; `data-scope.ts` rules for sandbox runners; verify exhaustive unit tests of the pure rule
- [x] 3.2 `runner-resolver.ts`: sandbox thread → only its runner, else `thread-sandbox-unavailable` (no fallback); `describeResolutionFailure` message; verify resolver tests (offline sandbox never routes to general/dedicated)
- [x] 3.3 gRPC events handler + type-tests: sandbox runner cannot emit events for another thread; verify `bun run lint:proofs` and `typecheck:proofs` still pass

## 4. Lifecycle (provider-neutral) and Boat provider

- [x] 4.1 Boat adapter over `@boatdev/sdk` (capabilities, create from template, status mapping, stop, resume, extendLifetime, destroy; errors → `expired`/`quota`/`rate-limited`/`unavailable`); verify it passes the shared contract suite with recorded fixtures
- [x] 4.2 `ThreadSandboxService` provisioning flow with Effect, driven only by capabilities (tested with the fake provider in both `stopPreservesDisk` modes) (bounded waits, retry only on 503, interruption on delete), state events to the user stream; verify tests incl. cancellation mid-provision
- [ ] 4.3 `thread:bootstrap` control command + runtime clone, branch `funny/<threadId>`, initial push; verify runtime + server tests incl. clone failure → `failed`
- [ ] 4.4 Thread creation use case: `runtime: 'sandbox'` path (reject scratch, reject no-remote, check running cap) starting the agent after bootstrap; verify use-case tests
- [ ] 4.5 Wake on demand in proxy for follow-up / PTY / files / git: single in-flight resume per thread, reconnect timeout, message preserved on failure; verify tests incl. concurrent wakes
- [ ] 4.6 Activity reporting from runtime (turn, permission prompt, PTY, commands) + idle sweeper (stop vs destroy by capability) + lifetime extension + startup reconciliation; verify tests that activity or pending backup blocks stop
- [ ] 4.7 Recovery on expired/missing sandbox: new sandbox from `origin/funny/<threadId>`, cold-path context, system notice; verify tests
- [ ] 4.8 Thread delete destroys sandbox + runner, optional remote branch delete; verify tests
- [x] 4.9 Provider-neutral `scripts/sandbox-templates/install-runner.sh` + `boat/build.ts` pinned to server version; verify by a documented run

## 5. Remote backup

- [ ] 5.1 Runtime checkpoint after turn: stage with ignore rules, secret denylist + size limit, commit with user identity, push with retry; `thread:backup` event; verify tests (no-change turn, `.env.local` excluded, push failure → pending → failed)
- [ ] 5.2 `funny runner pre-stop` command (final best-effort push) wired by the Boat template as `~/.boat/pre-stop`; verify in spike run
- [ ] 5.3 PR from thread branch using existing GitHub flow; verify route test

## 6. Agent credentials (moved from provision-railway-runners 4.5–4.7)

- [ ] 6.1 Normalize profile `configDir` to `~/…` on save + migration; verify unit tests
- [ ] 6.2 Headless Claude token per profile (`claude setup-token` via provider-login PTY, stored encrypted, never returned); verify tests incl. redaction
- [ ] 6.3 Deliver token per operation as `CLAUDE_CODE_OAUTH_TOKEN`; `profile.token_invalid` on rejection; verify a sandbox runner with no login runs an agent

## 7. Client

- [ ] 7.1 Settings > Infrastructure: provider list + config form from `GET /api/infra/providers`, add/test/delete connection (shadcn, data-testid, i18n en/es/pt); verify component tests
- [ ] 7.2 Thread compose: "Run in sandbox" toggle + connection/provider + size select from capabilities, disabled states with reasons (no connection, no remote, scratch, server not public, limit reached); verify component tests
- [ ] 7.3 Thread header: sandbox state (provisioning/connecting/bootstrapping/running/resuming/stopped/failed/lost), running time, backup badge, retry/stop actions; verify component tests

## 8. Docs & integration

- [ ] 8.1 openwiki page "Adding a sandbox provider" (contract, capabilities, template recipe, contract suite) + deploy runbook template step; verify docs reviewed
- [ ] 8.2 End-to-end against real Boat + Railway server: create sandbox thread from mobile, agent runs and pushes checkpoint, idle stop, follow-up resumes, delete removes sandbox; verify by recorded run notes
