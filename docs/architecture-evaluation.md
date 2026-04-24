# Architecture Evaluation Report

**Project:** funny (@ironmussa/funny)
**Date:** 2026-04-23
**Scope:** Production packages `shared`, `core`, `runtime`, `server`, `client`. Peripheral packages (`agent`, `api-acp`, `chrome-extension`, `evflow`, `memory`, `native-git`, `pipelines`, `reviewbot`, `sdk`) excluded.

---

## 1. Executive Summary

funny is a modular monolith delivered as a Bun workspace: a React 19 SPA talks to a Hono server that proxies agent/git/filesystem work to one or more stateless runners over a Socket.IO tunnel. The split between `server` (auth, DB, proxy) and `runtime` (execution) is well-respected — server code never imports runtime code, and the tunnel boundary is the only coupling between them. Runner-per-user isolation is enforced as a hard security rule (`runner-resolver.ts` scopes every lookup by `userId`) with HMAC-signed forwarded identity.

The strongest attributes are **deployability** (5/5) and **security** (4.5/5): stateless runners, NAT-friendly tunnel, AES-256-GCM secret storage, least-privilege role coercion, loopback-gated shared-secret auth. The weakest are **performance** (3/5) and **reliability** (3.5/5): `ws-broker` fan-out is O(N) per event, `thread-event-repository` persists one row per event without batching and silently swallows DB errors, and `try/catch` still outnumbers `neverthrow` in routes despite the stated project preference.

The most actionable architectural risk is file-level concentration, not coupling: `ReviewPane.tsx` (3,035 LoC), `routes/git.ts` (2,180 LoC), `VirtualDiff.tsx` (2,015 LoC), `shared/types.ts` (1,826 LoC), and `thread-service.ts` (1,456 LoC) each accumulate far more responsibility than their neighbors.

**Overall Architecture Health: 4.0/5**

---

## 2. Architecture Overview

- **Project type:** Web application for orchestrating parallel Claude Code agents via git worktrees.
- **Languages/Frameworks:** TypeScript (Bun runtime), Hono (server + runtime HTTP), Socket.IO (server↔runner tunnel), Drizzle ORM + SQLite/PostgreSQL, Better Auth, React 19 + Vite, shadcn/ui + Tailwind, Zustand, neverthrow, Claude Agent SDK, Playwright (E2E), Vitest.
- **Architecture style:** Modular monolith with an **extracted execution tier** (runner). Server is the single client-facing entry point; runner is a stateless executor.
- **Module map:**

```
         client (React SPA)
            │  HTTP /api + WebSocket /ws
            ▼
         server  ─── DB (SQLite/Postgres)  ◄── persistence owner
            │  Socket.IO tunnel (ws-tunnel.ts ↔ team-client.ts)
            ▼
         runtime  (one per user)
            │
            ▼
         core (git, agents, ports, containers) ── native-git (Rust addon)
            │
            ▼
         shared (types, errors, protocol, evflow model)
```

---

## 3. Quality Attribute Scorecard

| Attribute      | Score | Trend | Key Finding |
|----------------|-------|-------|-------------|
| Modifiability  | 4/5   | →     | Service decomposition is good; a handful of god-files concentrate risk. |
| Performance    | 3/5   | →     | O(N) ws-broker fan-out; unbatched per-event DB writes; residual sync git calls. |
| Testability    | 4/5   | ↑     | Strong DI (`service-registry`, `IThreadManager`/`IWSBroker`), 50+ test files, Node fallback in `git/process.ts` for vitest. |
| Deployability  | 5/5   | →     | Stateless runner, NAT-friendly Socket.IO tunnel, invite-token registration, hot-reload preserves active agents. |
| Security       | 4.5/5 | ↑     | Hard per-user runner isolation, HMAC identity, encrypted secrets, role least-privilege. |
| Reliability    | 3.5/5 | →     | WS reconnect + eviction solid; `try/catch` still dominates routes; repositories swallow DB errors. |

**Overall Architecture Health: 4.0/5**

---

## 4. Dependency Analysis

### 4.1 Inter-package edges (verified)

```
shared   ── (no internal deps; outbound only to @funny/evflow from evflow.model.ts)
core     ──► shared, native-git
runtime  ──► core, shared, memory, pipelines
server   ──► core, shared               (no edge to runtime — verified)
client   ──► shared                     (no edge to server/runtime/core)
```

The declared **server↔runtime** separation is honoured in code: 0 imports from `@funny/runtime` inside `packages/server`. Cross-tier communication uses only the Socket.IO tunnel (`server/services/ws-tunnel.ts` ↔ `runtime/services/team-client.ts`).

### 4.2 Coupling hotspots (afferent / importer count)

| Rank | Module | Importers | Role |
|------|--------|-----------|------|
| 1 | `client/src/lib/utils.ts` | 152 | `cn()` helper (expected) |
| 2 | `client/src/lib/api.ts` | 82 | **Architectural choke point** — all cross-tier calls |
| 3 | `client/src/stores/thread-store.ts` | 50 | Client state hub |
| 4 | `client/src/stores/project-store.ts` | 47 | Client state hub |
| 5 | `core/src/git/git.ts` | 28 | Core git facade |
| 6 | `runtime/src/services/thread-event-bus.ts` | 22 | Runtime backbone |
| 7 | `runtime/src/services/ws-broker.ts` | 16 | WebSocket fan-out |

`thread-event-bus` is the real runtime backbone (22 importers) — more central than `ws-broker`. Internal modularity is event-driven, which is a structural strength.

### 4.3 Circular dependencies

None found. `thread-service.ts` co-depends on `agent-runner`, `agent-state`, `thread-event-bus`, and `ws-broker` — a fan-in hotspot, not a cycle.

### 4.4 Blast-radius ranking

| File | LoC | Why risky |
|------|-----|-----------|
| `client/src/components/ReviewPane.tsx` | 3,035 | Top-level review UI — most prop/state paths pass through here |
| `runtime/src/routes/git.ts` | 2,180 | Every git HTTP endpoint plus ad-hoc service logic |
| `client/src/components/VirtualDiff.tsx` | 2,015 | Diff rendering; shared across review + commit views |
| `shared/src/types.ts` | 1,826 | Every other package imports from here |
| `client/src/lib/api.ts` | 1,679 | 82 importers; changes ripple through the client |
| `runtime/src/services/thread-service.ts` | 1,456 | Thread lifecycle + persistence + events all in one |
| `runtime/src/routes/github.ts` | 1,430 | GitHub CLI wrapping + PR flows |
| `client/src/components/CommitHistoryTab.tsx` | 1,388 | |
| `client/src/components/thread/ProjectHeader.tsx` | 1,282 | |
| `client/src/components/PromptInputUI.tsx` | 1,243 | |
| `runtime/src/services/git-pipelines.ts` | 1,233 | |
| `runtime/src/services/team-client.ts` | 1,193 | Runtime side of the tunnel |
| `server/src/db/migrate.ts` | 1,007 | Raw SQL — maintenance risk (per CLAUDE.md) |

---

## 5. Design Principle Adherence

| Principle | Score | Key observation |
|-----------|-------|-----------------|
| SRP       | 3/5   | Respected at module level; violated in `ReviewPane.tsx`, `routes/git.ts`, `thread-service.ts`. |
| OCP       | 4/5   | Agent providers are plug-in (`core/src/agents/process-factory.ts`); PTY backends are pluggable (headless → bun → node-pty → null). |
| DIP       | 4/5   | `IThreadManager`/`IWSBroker`/`IClaudeProcess` interfaces drive the runtime; `service-registry.ts` allows test substitution. |
| ISP       | 3.5/5 | Interfaces are cohesive; `thread-service.ts` still acts as a wide facade. |
| Demeter   | 3.5/5 | Most reach-through lives in `ReviewPane`/`thread-service`. |
| Contracts | 4/5   | `shared/runner-protocol.ts` + `shared/auth/forwarded-identity` formalise the server↔runner contract; HMAC-signed. |

---

## 6. Findings

### CRITICAL
*None.* The architecture has no hard cycles, no cross-tenant data paths, no layer-bypassing imports.

### HIGH
- **Silent DB failures in repositories.**
  `packages/server/src/services/thread-event-repository.ts:19-77` catches DB errors, logs, and returns empty — persistence failure becomes a ghost success. High blast-radius because every agent event flows through here.
  *Fix:* return `Result<T, DomainError>` and let callers decide.

- **`routes/git.ts` (2,180 LoC) absorbs service logic.**
  Every git endpoint lives in one file with 42 `try/catch` blocks; service-layer extraction is incomplete. Adding a git feature means editing this file, `services/git-service.ts`, core, and client `api.ts`.
  *Fix:* split into `routes/git/{diff,commit,branch,stash,remote}.ts` sub-routers that call `git-service.ts`.

- **`ReviewPane.tsx` at 3,035 LoC.**
  Dominant UI surface, many props, co-manages diff state + commit actions + stage/unstage + PR creation. Modifiability and testability both degrade with every feature.
  *Fix:* extract a `useReviewState` hook and split the action bar, diff viewer, and commit composer.

### MEDIUM
- **ws-broker fan-out is O(N) per event** (`packages/runtime/src/services/ws-broker.ts:154-178`). Iterates full client `Map` per event; no per-user index. Drops >10 MB but doesn't chunk.
  *Fix:* index by `userId` (`Map<userId, Set<WS>>`).

- **Unbatched per-event inserts in `thread-event-repository.ts`.** High-rate agent streams create write amplification.
  *Fix:* debounced batch insert (`INSERT ... VALUES (...), (...)`).

- **Tunnel fetch has no retry.** `packages/server/src/services/ws-tunnel.ts:62-77` rejects on 30s timeout with no bounded retry; mid-stream runner flaps surface to the client as broken requests.
  *Fix:* exponential backoff, max 3 attempts, only for idempotent methods.

- **Local-auth fallthrough in tunnel-only mode** (`packages/runtime/src/middleware/auth.ts:149`). If server-session validation fails, the runtime falls back to local Better Auth — in a deployment with `TEAM_SERVER_URL` set, this is an ambiguous fallback.
  *Fix:* gate the fallback on `!TEAM_SERVER_URL`.

- **Residual sync git/shell calls** (`packages/core/src/git/base.ts:68` `executeSync`, `isGitRepoRootSync` at `base.ts:106`, and several sync calls in `runtime/src/routes/browse.ts`, `runtime/src/services/shell-detector.ts`, `runtime/src/app.ts`). Used in project-registration hot paths.
  *Fix:* migrate remaining sync paths to `gitRead`/`execute` async pools.

- **`shared/types.ts` (1,826 LoC)** is a god-file for types — touched by every other package.
  *Fix:* split by feature area (`types/thread.ts`, `types/git.ts`, `types/runner.ts`, `types/agent.ts`).

### LOW
- `thread-service.ts` (1,456) could split into `thread-lifecycle`, `thread-persistence`, and `thread-events`.
- `db/migrate.ts` (1,007 LoC raw SQL) — consider formal Drizzle migrations once schema stabilises.
- `routes/github.ts` (1,430) mirrors `routes/git.ts`: split by operation group.
- Client `lib/api.ts` (1,679, 82 importers) is one change away from touching every feature — consider grouped API namespaces (`api.git.*`, `api.thread.*`).

---

## 7. Tradeoff Analysis

| Decision | Benefits | Costs | Aligned? |
|----------|----------|-------|----------|
| Stateless runner + tunnel to server | NAT-friendly, scales horizontally, clean trust boundary | Extra hop latency; server becomes single point of failure | ✅ Yes |
| All persistence on server | Runner restart ≈ stateless; single source of truth | Every agent event crosses the tunnel to persist | ✅ Yes — matches privacy goals |
| SQLite default + optional Postgres | Zero-config for users; upgrade path exists | Raw-SQL migration file (1,007 LoC) with two dialects | Partially |
| One WebSocket multiplexed stream | Simpler client code; single reconnect logic | `ws-broker` must filter per-user; O(N) fan-out today | Partially — fan-out needs indexing |
| `try/catch` still dominant despite `neverthrow` preference | Familiar to contributors; Hono-friendly | Inconsistent error shape; repository layer swallows errors | ❌ Not — diverges from CLAUDE.md mandate |
| Large files in review/git surface | Ships features quickly | High blast radius; onboarding friction | ❌ Drift |

---

## 8. Recommendations (Prioritised)

### Quick Wins (low effort, high impact)
1. **Gate local-auth fallback on `!TEAM_SERVER_URL`** (`packages/runtime/src/middleware/auth.ts:149`) — one conditional, removes an ambiguous auth path.
2. **Convert `thread-event-repository.ts` to `Result`-returning** — 3 functions, unblocks reliable error propagation.
3. **Index `ws-broker` clients by `userId`** — ~50 lines, meaningfully improves fan-out under load.
4. **Bounded retry on `ws-tunnel.tunnelFetch`** for idempotent methods.

### Strategic Improvements (higher effort, high impact)
1. **Split `routes/git.ts` and `routes/github.ts`** into sub-routers per operation group; extract all remaining logic into `git-service.ts`.
2. **Decompose `ReviewPane.tsx`** via `useReviewState` hook + three sub-components; drives a client-wide pattern.
3. **Batch `thread_events` inserts** behind a 50 ms debounce; measurable write-amplification relief.
4. **Add contract tests for `IThreadManager` / `IWSBroker`** — run the same suite against both local and remote implementations to keep them interchangeable.

### Long-term Refactoring (foundational)
1. **Split `shared/types.ts` by feature area** — prerequisite for any future `@funny/*` package extraction.
2. **Migrate remaining sync git/shell paths to async pools** (`base.ts:68`, `browse.ts`, `shell-detector.ts`).
3. **Drizzle migrations** once schema stabilises; retire `server/db/migrate.ts`.
4. **Split `thread-service.ts`** into lifecycle / persistence / events modules.

---

## 9. Suggested Fitness Functions

Integrate these as CI checks (all runnable with `bunx`):

| Property | Tool | Config |
|----------|------|--------|
| **No server → runtime imports** | `dependency-cruiser` | Rule: `from: packages/server` → `to: packages/runtime` = ❌ |
| **No client → server/runtime/core imports** | `dependency-cruiser` | Rule: client may only import `shared` + own source |
| **No shared → non-shared imports** | `dependency-cruiser` | Rule: shared is a leaf (except `@funny/evflow`) |
| **No circular dependencies in runtime/** | `madge --circular packages/runtime/src` | Fail on any cycle |
| **File size ceiling** | Custom script or ESLint `max-lines` | Warn >800, fail >2000 (grandfather existing then ratchet down) |
| **No new `executeSync` outside `core/git/process.ts`** | ESLint custom rule / `no-restricted-imports` | Block regression |
| **`try/catch` cap in routes** | Custom grep check in CI | Ratchet down: snapshot current count, fail on increase |
| **Per-route `userId` scoping** | Grep check | Every route calling `resolveUserRunner` must have preceding `requireAuth` middleware |
| **`data-testid` on interactive elements** | ESLint rule / custom check | Per CLAUDE.md UI rules |
| **No new hard-coded font sizes in client** | ESLint `no-restricted-syntax` for `fontSize:` literals | Enforce Settings > Appearance scaling |

Suggested CI wiring: a single `bun run arch:check` script that runs `dependency-cruiser`, `madge`, and the custom scripts; fails the build if any fitness function regresses.
