# Plan: Portable server (Bun or Cloudflare Workers + Durable Objects)

Status: **In progress** — Phase 1 done (pending Railway deploy check); Phase 0 spike next. Owner: TBD.

## Goal

Run the central server (`packages/server`) and the client on **either** host without forking the code:

- **Bun host** (today): one long-lived Bun process, SQLite or Postgres, state in process memory.
- **Cloudflare host**: Workers for HTTP, Durable Objects (DOs) for process-lifetime state and long-lived sockets, Postgres via Hyperdrive, Workers Static Assets for the client.

The runner (`packages/runtime`) never runs in a Worker (it spawns processes, PTYs, git). It keeps running on user machines, Railway, or sandboxes; a Cloudflare Sandbox provider is an independent, optional track (Phase 6).

## Non-goals

- D1 as the primary database (no interactive transactions; see Risks). Postgres via Hyperdrive only.
- Replacing Better Auth, Drizzle, Hono, or the `runner.v2` / `browser.v1` protocols. We swap **carriers and hosts**, not protocols.
- Adopting RivetKit (3.x requires its own engine process; no 3.x Cloudflare driver as of 2026-11).
- Multi-instance Bun deployments (enabled as a side effect of Phase 2, not delivered here).

## Principles

1. **Every phase ships on Bun alone.** Phases 1–4 are refactors that leave Bun behavior unchanged and are worth having even if the Cloudflare host is dropped. Phase 5 is the first Cloudflare-only work.
2. **Ports with two implementations.** Process-lifetime state goes behind ports; the in-memory implementation is today's code moved, the DO implementation is added in Phase 5.
3. **Security invariants are re-proved, never relaxed.** See [Invariants](#security-invariants-that-must-hold-on-both-hosts).
4. **Carriers, not protocols.** Both wire protocols already carry their own semantics (epochs, acks, gaps, replay, idempotency, typed failures), so only the framing layer changes.

## Current state (inventory, 2026-11-09)

| Area                   | Today                                                                                                                                                                                                                                                                                                                                                                                       | Blocker for Workers                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner transport       | `runner.v2`: 5 bidi gRPC streams (Control, Operations, Events, Tunnel, Terminal) on a `@grpc/grpc-js` HTTP/2 listener. Default public carrier pipes HTTP/2 bytes over WS (`services/grpc/websocket-carrier.ts`) into the local listener via `Bun.connect`.                                                                                                                                  | No HTTP/2 / TCP listener in Workers. **But** handlers only use the `RunnerGrpcCall` duplex surface; only `runner-grpc-server.ts` imports grpc-js. Runtime already has a `transportFactory` plug (`grpc-runner-client.ts`).   |
| Browser realtime       | Socket.IO 4.8 on `@socket.io/bun-engine`, in-memory rooms (`user:*`, `thread:*:stream`, `thread:*:presence`), acks, polling fallback. ~70 legacy JSON event types; `browser.v1` protobuf only for browser-session (and flagged classes).                                                                                                                                                    | Socket.IO does not run on Workers. Client already has `ClientRealtimePort` (`client-core/src/realtime.ts`) but legacy events bypass it (`ws-event-dispatch.ts`). Server inbound handlers take a Socket.IO `Socket` directly. |
| Process-lifetime state | ~30 modules with module-level maps: session registry (epochs from 0 every boot), tunnel/terminal dispatchers, presence roster, v1 retention, outbound queues, resource store, input ordinals, pipeline approval waiters, scheduler event buffer, receipt/idempotency `inFlight`, caches (`runner-scope`, `runner-resolver`, `data-scope`, `data-ownership`), rate limiters, login throttle. | Lost between requests; several are security-critical. `RunnerPresencePort` is **synchronous**.                                                                                                                               |
| Timers / jobs          | croner automations ("every process fires every automation"), sandbox reconcile/sweep every 60 s, session guard intervals, heartbeat timers, boot-time `purgeAllRunners`.                                                                                                                                                                                                                    | Need single-firing alarms; boot-time purge assumes one process owns all runners.                                                                                                                                             |
| Database               | `pg` Pool (max 10) or `bun:sqlite`; global lazy `db` Proxy + `AsyncLocalStorage`; adapters loaded with `require()`; ~90 migrations run on every boot.                                                                                                                                                                                                                                       | Per-request connection from `env.HYPERDRIVE`; static imports; migrations as a deploy step.                                                                                                                                   |
| Secrets / files        | `DATA_DIR` (`auth-secret`, `encryption.keys.json`, `admin-password.txt`, logs, extensions); `oauth-callback-state.ts` uses a **random per-process HMAC key**.                                                                                                                                                                                                                               | No filesystem; secrets must come from bindings.                                                                                                                                                                              |
| HTTP host              | Hono inside `Bun.serve`, `hono/bun` `serveStatic` + `getConnInfo`, `Bun.file`, `process.exit`/signal handlers.                                                                                                                                                                                                                                                                              | Export a `fetch` handler; Static Assets; `cf-connecting-ip`.                                                                                                                                                                 |
| Other deps             | winston + DailyRotateFile, `@abbacchio/transport`, nodemailer (SMTP/TCP), web-push.                                                                                                                                                                                                                                                                                                         | File logging; SMTP; verify Abbacchio and web-push under `nodejs_compat`.                                                                                                                                                     |

Fine as-is on Workers (with `nodejs_compat`): Hono, Drizzle, Better Auth, `pg` ≥ 8.13, `node:crypto` usage (AES-256-GCM, HMAC), Effect, neverthrow, `@bufbuild/protobuf`.

## Security invariants that must hold on both hosts

Each phase that touches routing or realtime must keep these, with tests on both implementations of every port:

- **Runner isolation**: every server → runner request goes through `AuthorizedRunnerRequests` with a `RunnerFor<A, R>` proof; no fallback to another user's runner; 502 when unavailable.
- **Project ↔ runner binding**: `runner-scope.ts` stays the single rule; dedicated runners serve only pinned/granted projects.
- **Data channel scope**: every `data:*` type has a `DATA_SCOPE_RULES` entry; unknown types refused.
- **Steer-share delegation**: allow-list, `sendDelegated` only from `middleware/proxy.ts`, audit record, signed claim.
- **Realtime isolation**: user rooms per user; the owner never joins the thread stream room; share revoke evicts viewers.
- **Terminal ownership**: output relayed only to the terminal's owning user.
- **Epoch fencing**: a replaced runner session cannot act.
- **MCP OAuth callback**: routes only to the runner bound in the server-signed `state`.
- `scripts/fitness/check-runner-request-sinks.ts`, `lint:proofs`, `typecheck:proofs` keep passing.

## Phases

Estimates assume one engineer familiar with the codebase; they are ranges, not commitments.

### Phase 0 — Cloudflare spike and go/no-go (≈1 week)

Throwaway prototype outside the main tree. Answers the unknowns that could kill the Cloudflare host before we invest in Phases 3–5:

- [ ] A DO terminating an outbound runner WebSocket: max message size vs our 32 MiB / frame limits, hibernation API with a socket that must stay open for hours, send backpressure signals (`bufferedAmount` equivalent), alarm-based heartbeat expiry.
- [ ] Browser WebSocket into a per-user DO with cookie auth at upgrade (Better Auth session check from the Worker).
- [ ] `pg` over Hyperdrive with Drizzle: per-request client, an interactive transaction, latency from a DO.
- [ ] Cost model for a realistic workload (N users, M runners, event rates) on DOs vs a Railway instance.

**Exit:** written go/no-go. If no-go, Phases 1–4 still proceed for their Bun-side value (testability, multi-instance readiness, dropping the HTTP/2-over-WS bridge); Phase 5 is cancelled.

### Phase 1 — Host seam on Bun (≈2–3 weeks, no behavior change)

- [x] Split `packages/server/src/index.ts` into `createServerApp(deps)` (pure composition: Hono app, routes, middleware) and `hosts/bun/main.ts` (`Bun.serve`, signals, static files, boot sequence). Remove top-level `process.exit` from the composition path. _Done: `src/app.ts`, `src/hosts/bun/{main,assets}.ts`._
- [x] `SecretProvider` port: auth secret, encryption keyring, OAuth state key, runner auth secret. Bun implementation keeps today's env-then-`DATA_DIR` behavior. **Fix**: OAuth state HMAC key no longer random per process (needed for any multi-instance setup). _Done: `src/lib/server-secrets.ts` (`SecretSource`, auth secret, HKDF-derived OAuth state key) and the keyring as a `KeyringSource` in `@funny/shared/lib/crypto` (files by default, read-only `FUNNY_ENCRYPTION_KEYS`). `RUNNER_AUTH_SECRET` stays a plain env var checked at boot._
- [x] DB: injected factory instead of the env-driven one; make the `db` Proxy resolve the connection from request context (ALS) so a host can supply one per request. Keep the Bun singleton path. _Done: `useDatabaseProvider` / `runWithDatabase` in `db/index.ts`. The lazy `require()` in `@funny/shared/db/connection` stays (it keeps `pg` and `bun:sqlite` from loading together); a Workers host builds its provider from `adapters/pg.ts` directly and must alias `bun:sqlite` out of its bundle (Phase 5)._
- [x] Migrations runnable as a standalone command (`bun run db:migrate`); Bun host still auto-migrates at boot. _Done: `src/hosts/bun/migrate-cli.ts`._
- [x] Logger sink port (winston file transport on Bun; console/OTLP-over-fetch elsewhere). `data-dir.ts` stops creating directories on import. _Done: `ensureDataDir()` and `attachFileLogTransport()`, both called by the Bun host at boot. Still to check in Phase 0/5: Winston and `@abbacchio/transport` under `nodejs_compat`._
- [x] Client IP via a host-provided function (`getConnInfo` on Bun, `cf-connecting-ip` on Workers). _Done: `src/lib/client-ip.ts` reads the `IP` the host puts in the env. **Fixed a bug on the way:** `hono/bun` `getConnInfo` always threw with the server's env, so anonymous requests were never rate-limited by IP unless `TRUST_PROXY=true`._

**Exit:** `bun run lint`, `bun run typecheck`, full server test suite green; deploy to Railway unchanged.

### Phase 2 — Async state ports (≈2–3 weeks, no behavior change)

Move every item of the inventory behind a port, with today's code as the in-memory implementation:

- [ ] **Make `RunnerPresencePort` async** (`isAvailable`, `userHasAvailableRunner`, `userIdForRunner`) and update callers, including `runner-access/runner-for.ts`. `RunnerTerminalPort` likewise. Proof types and fitness checks unchanged.
- [ ] `RunnerSessionHub` port: activate/heartbeat/invalidate, epoch allocation, tunnel and terminal stream attachment (wraps `session-registry.ts`, `tunnel-handler.ts`, `terminal-handler.ts`).
- [ ] `RealtimeHub` port (server inbound side of the browser): join/leave scopes, fan-out targets, eviction, connected-user listing — today implemented with Socket.IO rooms. `BrowserEventSink` already covers outbound.
- [ ] Stores: v1 event retention, input ordinals, resource store, thread presence roster, pipeline approval waiters, scheduler event buffer (or delete it if confirmed unused), receipt/idempotency in-flight coordination.
- [ ] `RateLimitStore` for `middleware/rate-limit.ts`, login throttle, socket rate counters.
- [ ] `JobScheduler` port with "fire once per schedule" semantics for automations and the sandbox lifecycle tick; replace boot-time `purgeAllRunners` with presence-derived state.
- [ ] Cache invalidation port for `runner-scope` / `runner-resolver` / `data-scope` / `data-ownership` (in-process call today; see Risks for the cross-isolate design).

**Exit:** no module-level mutable state outside port implementations (add a fitness check that flags new module-level `Map`/`Set` in `services/**` outside `*/memory/*` implementations).

### Phase 3 — Runner carrier: `runner.v2` directly over WebSocket (≈3–4 weeks)

- [ ] **Decide framing**: one WebSocket per stream class (5 sockets, no head-of-line blocking, no mux envelope) vs. one multiplexed socket with a framing envelope. Default recommendation: one socket per class.
- [ ] If an envelope is needed, add it under `protocol/runner/v2/` with Buf breaking checks and golden fixtures (per `protocol/runner/v2/README.md`).
- [ ] Server: WS endpoint + adapter that presents the `RunnerGrpcCall` duplex surface to the existing handlers; move Bearer auth, auth timeout, correlation id and per-runner stream quota from the grpc-js interceptor to the WS upgrade. Map call-ending statuses to close codes / final `Failure`.
- [ ] Codec on Buf generated schemas (`packages/shared/src/generated/runner-v2`), with a normalizer to the proto-loader shapes the handlers expect (Struct, Duration, Timestamp, oneof `message`) — or migrate the handlers to Buf shapes.
- [ ] Backpressure: replace HTTP/2 flow control with `bufferedAmount` / credits using the negotiated `max_buffered_bytes_per_class`.
- [ ] Runtime: new `RunnerGrpcTransport` passed via `transportFactory`; retire `grpc-websocket-bridge.ts`.
- [ ] Rollout: runner advertises carrier capability; server keeps the gRPC listener behind a flag until the WS carrier is default; then remove grpc-js from server and runtime.
- [ ] Port the `packages/runner-grpc-harness` scenarios (keepalive/liveness, deadlines, slow-reader backpressure, oversize frame → `RESOURCE_EXHAUSTED`, reconnect, ingress) as the WS carrier's acceptance suite. Retire the Rust compat clients or rewrite them against WS.

**Exit:** runners on Railway and local machines connect over the WS carrier by default; harness-equivalent suite green; gRPC listener removed.

### Phase 4 — Browser carrier: plain WebSocket (≈4–6 weeks)

- [ ] **First finish `browser.v1`**: move the ~70 legacy event types and `thread:open/close` onto `browser.v1` envelopes and make `binary` the default for events, operations and terminal. This shrinks the carrier to `CarrierEnvelope` frames plus ack ids.
- [ ] Route all client traffic through `ClientRealtimePort`; remove direct Socket.IO bindings from `use-ws.ts` and `ws-event-dispatch.ts`.
- [ ] Server: inbound socket abstraction replacing the Socket.IO `Socket` in `socketio/*.ts` handlers and `router.ts`; plain WS implementation (crossws) with cookie + Origin check at upgrade, session guard, request-id acks, `bufferedAmount` backpressure, queue budgets unchanged.
- [ ] Client: WS implementation of `ClientRealtimePort` with reconnect/backoff and resume cursors.
- [ ] Per `docs/browser-v1-transport.md`: separate OpenSpec change with browser and WebView soak evidence; decide what replaces the polling fallback (or accept WS-only).
- [ ] Rollout behind a flag; remove Socket.IO when the WS carrier is default.

**Exit:** client and server speak `browser.v1` over plain WebSocket; Socket.IO removed; acceptance thresholds in `protocol/browser/v1/acceptance.json` met.

### Phase 5 — Cloudflare host (≈4–6 weeks, only if Phase 0 is "go")

- [ ] `hosts/cloudflare/`: Worker entry calling `createServerApp` with Cloudflare implementations; `wrangler` config with Hyperdrive, DO classes, Static Assets, secrets, cron triggers.
- [ ] DO topology (to validate in Phase 0):
  - `RunnerSessionDO` — one per runner: the 5 carrier sockets, epoch counter in DO storage (monotonic across restarts, which is stricter than today), heartbeat expiry via alarm, tunnel and terminal dispatch, receipt serialization (single-threaded per runner fixes the "single store instance" assumption in `event-receipts.ts`).
  - `UserHubDO` — one per user: browser sockets, user-scope fan-out, v1 retention and cursors, input ordinals, index of the user's online runners (answers `userHasAvailableRunner`).
  - `ThreadHubDO` — one per shared thread: presence roster and stream-room membership across users (share viewers), eviction on revoke.
  - `SchedulerDO` — singleton: automations and sandbox lifecycle tick via alarms.
  - Rate limits / login throttle: DO per key or Workers Rate Limiting binding.
- [ ] Presence and routing: `RunnerFor` asks `RunnerSessionDO` (async presence from Phase 2); ownership still verified against `runners.user_id`.
- [ ] Resource store (screencast frames): store in the owning `UserHubDO` (or R2 with short TTL) so the HTTP fetch reaches the same place.
- [ ] Migrations as a deploy step; admin bootstrap via env secret or one-time setup route (no `admin-password.txt`).
- [ ] Mail via an HTTP API; verify web-push and Abbacchio telemetry under `nodejs_compat`.
- [ ] Deploy guide (`docs/guides/cloudflare-deploy.md`) and a one-click deploy template.

**Exit:** the full E2E suite (`e2e/`) passes against a Cloudflare deployment with a Railway runner and a local runner; all invariants' tests pass against the DO implementations.

### Phase 6 — Cloudflare Sandbox provider (≈1–2 weeks, independent)

Can start any time; does not depend on Phases 1–5.

- [ ] `providers/cloudflare/` implementing `SandboxProvider` (`thread-sandboxes/contract.ts`), talking to a small companion Worker + DO in the user's Cloudflare account.
- [ ] Runner as a Docker image per server commit (no `systemd`/`sudo`; replaces `runner-install-script.ts` for this provider).
- [ ] Start with `stopPreservesDisk: false` (recover from the thread branch); optional R2 directory backups later.
- [ ] Verify sleep behavior with an outbound-only runner connection, isolation level, and size limits (≈4 vCPU / 12 GiB self-serve, unconfirmed).

## Quick win (independent)

Serving the client from Cloudflare (Static Assets) with the server elsewhere works today **only same-site**: Better Auth cookies are `SameSite=Strict`, so the client and API must share a registrable domain (e.g. `app.example.com` + `api.example.com`) and CORS must allow the client origin. Otherwise wait for Phase 5.

## Risks and open decisions

- **Cache invalidation across isolates (security).** `runner-scope` caches routing policy for 30 s with in-process invalidation. On Cloudflare a grant revocation or dedicated-runner change could be served stale by other isolates. Options: version stamp in the DB checked per request, invalidation broadcast through a DO, or no cache for policy reads. **Must be decided in Phase 2**; a stale window is not acceptable for revocations.
- **Async presence ripple.** Making presence async touches the `RunnerFor` prover; keep the change mechanical and covered by `typecheck:proofs`.
- **Head-of-line blocking** if the runner carrier multiplexes all classes on one socket (large tunnel bodies stalling heartbeats) — mitigated by one socket per class.
- **Backpressure** is weaker on DO WebSockets than HTTP/2 flow control; rely on the in-band buffer budgets that already exist.
- **Polling fallback disappears** with plain WebSocket; some corporate proxies block WS.
- **DO hibernation vs long-lived runner sockets**: confirm in Phase 0 that a runner socket held for hours is billed and behaves as expected.
- **D1** stays out of scope: 4 interactive `db.transaction` sites plus `withDatabaseTransaction` (receipts, idempotency, thread/project creation) would need rewrites.
- **Portability tax**: two implementations of every port must be tested; add a shared contract-test suite per port run against both.
- **Opportunity cost**: Phases 3–5 are ~3–4 months. Re-check the go/no-go after Phase 2 against product priorities.

## Sequencing summary

| Phase                 | Depends on  | Value on Bun alone                            | Estimate |
| --------------------- | ----------- | --------------------------------------------- | -------- |
| 0 Spike               | —           | Decision                                      | ~1 wk    |
| 1 Host seam           | —           | Testability, secrets cleanup, OAuth state fix | 2–3 wk   |
| 2 Async ports         | 1           | Multi-instance readiness, no stray state      | 2–3 wk   |
| 3 Runner WS carrier   | 2           | Drops grpc-js and the HTTP/2-over-WS bridge   | 3–4 wk   |
| 4 Browser WS carrier  | 2           | Drops Socket.IO, finishes `browser.v1`        | 4–6 wk   |
| 5 Cloudflare host     | 0 (go), 1–4 | —                                             | 4–6 wk   |
| 6 CF sandbox provider | —           | Cheaper sandboxes option                      | 1–2 wk   |

Phases 3 and 4 can run in parallel after Phase 2.
