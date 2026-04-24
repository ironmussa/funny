# Architecture Evaluation Report

**Project:** funny — Claude Agent orchestration UI (Bun monorepo)
**Date:** 2026-04-23
**Evaluation scope:** All `packages/*` excluding `chrome-extension`, `sdk`, `native-git`, `reviewbot` (scoped to the core five + agent/pipelines surface)
**Methodology:** ATAM + SAAM-inspired, ISO 25010 attributes, coupling/instability metrics.

---

## 1. Executive Summary

funny is a **modular monolith** split into a foundation layer (`shared`, `core`), an execution layer (`runtime`, `agent`), a control-plane (`server`), and a presentation layer (`client`). The dependency graph is **acyclic** and follows a clean instability gradient (`shared → core → {runtime, server, client, agent}`), with the server/runtime split correctly enforced: the server never imports the runtime and proxies filesystem/git work over a typed WebSocket tunnel. The agent-process subsystem is the cleanest part of the codebase — a polymorphic `IAgentProcess` interface with a registry-based factory makes adding providers (claude, codex, gemini, deepagent, llm-api, openswe) a local change.

The biggest architectural liabilities are **concentrated mass** rather than bad shape: `runtime/routes/git.ts` (2180 lines), `client/components/ReviewPane.tsx` (3035 lines), `client/lib/api.ts` (1679 lines), and `runtime/services/thread-service.ts` (1456 lines) each carry far more responsibility than their filename suggests, and are the modules where incidental changes most often collide. Secondary concerns: `neverthrow` is the stated error-handling policy (CLAUDE.md) but adoption is ~5% — the codebase is still predominantly `throw`/`try`/`catch`, which is internally inconsistent. Client test coverage ratio (35 test files to 386 source files) lags the backend. These are fixable incrementally without disturbing the good shape of the package boundaries.

Top three actions: split `git.ts` into domain-grouped sub-routers, extract `ReviewPane` into composed subcomponents, and add a `dependency-cruiser` fitness function to CI so the current clean graph doesn't regress under change pressure.

---

## 2. Architecture Overview

- **Project type:** Local-first web app + remote runner mode (multi-tenant). Also packaged as Tauri desktop + `bunx funny` CLI.
- **Languages/Frameworks:** TypeScript + Bun (runtime), Hono (HTTP), Drizzle ORM + SQLite/PG, React 19 + Vite + Zustand + shadcn/ui, Socket.IO, `@anthropic-ai/claude-agent-sdk`, Playwright for E2E.
- **Architecture style:** **Modular monolith with a detachable runner.** Server + Runner are always separate processes and can be co-located or on separate machines. Data-plane flows `Client → Server → Runner` over WS tunnel.
- **Module map (verified):**

```
shared ──────────────────────────────────┐
   │ (types, errors, auth, runner-protocol, thread-machine, db schema)
   ▼
core ────────────────────────────────────┤
   │ (git/*, agents/*, containers/*, ports/*, symbols/*)
   ▼                                       │
runtime ──→ core + shared + pipelines + memory
   │ (Hono routes, agent-runner, pty-*, ws-broker, automation-*)
   │
server ───→ core/git + shared               (NEVER → runtime)
   │ (auth, DB, project-manager, runner-manager, socketio hub, ws-tunnel)
   ▼
client ───→ shared only
   │ (React 19 SPA; talks to server via /api + /ws)
```

---

## 3. Quality Attribute Scorecard

| Attribute       | Score | Trend | Key finding |
|-----------------|:----:|:----:|-------------|
| Modifiability   | 3/5 | →  | Good at the package seam, poor inside a handful of fat files (git.ts, ReviewPane.tsx, thread-service.ts). |
| Performance     | 3/5 | →  | Virtual-diff rendering and headless-xterm state are well-considered; no obvious N+1; WebSocket is a single multiplexed stream, which is pragmatic but a hot path worth watching. |
| Testability     | 3/5 | ↑  | Backend has 48 runtime + 15 server test files and integration-style git tests. Client (9% file-to-test ratio) is thin; no tests cover ReviewPane directly. |
| Deployability   | 4/5 | →  | Real separation of server/runner with a shared WS tunnel lets runners sit behind NAT. Single `bunx funny` entry for end users. |
| Security        | 4/5 | ↑  | Per-user runner isolation is enforced (`runner-resolver.ts`), GH tokens encrypted at rest (AES-GCM), recent audit commit (`a196855e`), auth via Better Auth. Runner trust boundary is explicitly documented. |
| Reliability     | 3/5 | →  | Session resumption + persisted thread events are first-class; error paths dominated by `try/catch` with inconsistent recovery; ws-broker is a single point of coordination. |

**Overall Architecture Health: 3.3 / 5** — structurally healthy, internally fat in a few files.

---

## 4. Dependency Analysis

### 4.1 Module dependency graph

No cycles. All edges flow from high-stability (shared, core) toward terminal consumers (server, client, agent). Key edges:

- `runtime → core, shared, pipelines, memory`
- `server → core/git, shared` (no runtime)
- `client → shared` (nothing else)
- `agent → core/agents, core/git, sdk, shared`

### 4.2 Coupling metrics

| Package     | Ce | Ca | I = Ce/(Ce+Ca) | Files | Tests | Notes |
|-------------|:--:|:--:|:-------------:|:----:|:----:|-------|
| shared      | 1  | 5  | 0.17 | 36  | 9  | Correct foundation (low I, high Ca) |
| core        | 2  | 4  | 0.33 | 70  | 14 | Pure logic, no HTTP/DB |
| runtime     | 6  | 1  | 0.86 | 171 | 48 | Correctly high-I consumer |
| server      | 3  | 0  | 1.00 | 62  | 15 | Terminal layer |
| client      | 2  | 0  | 1.00 | 386 | 35 | Terminal layer; heavy |
| agent       | 4  | 0  | 1.00 | 50  | 15 | Terminal extension |
| pipelines   | 0  | 1  | 0.00 | 4   | 1  | Leaf |

### 4.3 Circular dependencies

**None at the package level.** (File-level cycles inside `runtime/services/` weren't measured — a dependency-cruiser pass in CI would close this gap.)

### 4.4 Blast radius (qualitative)

| Module | Blast radius | Why |
|--------|--------------|-----|
| `shared/src/types.ts` (50 KB) | **Very High** | Types used in every package; a breaking change ripples everywhere. |
| `shared/src/runner-protocol.ts` | **High** | Contract between server WS-tunnel and runner; changes require coordinated rollout. |
| `core/src/git/process.ts` | **High** | Concurrency-pooled process executor; all git + shell goes through it. |
| `runtime/src/services/thread-service.ts` | **High** | 1456-line orchestrator touching DB, ws-broker, agent-runner. |
| `runtime/src/routes/git.ts` | **High** | 2180-line router; almost any git change lands here. |
| `client/src/components/ReviewPane.tsx` | **Medium-High** | 3035-line UI; isolated to UI but a co-edit magnet. |

---

## 5. Design Principle Adherence

| Principle | Score | Notable violations |
|-----------|:-----:|--------------------|
| SRP | 2/5 | ReviewPane.tsx (3035), git.ts (2180), VirtualDiff.tsx (2015), api.ts (1679), thread-service.ts (1456), team-client.ts (1193). |
| OCP | 4/5 | Agent registry is genuinely open for extension (`registerProvider`). Routes are not extensible by design, which is fine. |
| DIP | 4/5 | `core/src/ports/` defines abstract interfaces; `RuntimeServiceProvider` has two implementations (local SQLite vs remote-over-WS). Server imports from `core/git` only — no downward dependency from core to runtime. |
| ISP | 3/5 | `RuntimeServiceProvider` aggregates ~10 service facets; consumers take the whole provider rather than narrower ports. |
| Law of Demeter | 3/5 | Fat React components reach deep into Zustand store shape; `app-store.ts` is central knowledge. |
| Contracts | 5/5 | `WSEvent` is a discriminated union of ~30+ variants with per-variant typed `data` payloads; `runner-protocol.ts` is explicit. |

---

## 6. Findings

### CRITICAL

_None._ The dependency graph is acyclic, the server/runtime separation is real, and per-user runner isolation (the explicit hard boundary in CLAUDE.md) is enforced. No architectural time-bombs observed.

### HIGH

- **Monolithic hot files magnify blast radius.** `runtime/routes/git.ts` (2180 lines), `client/components/ReviewPane.tsx` (3035), `client/lib/api.ts` (1679), `runtime/services/thread-service.ts` (1456). Any non-trivial change concentrates edits here and increases merge conflicts between parallel agent worktrees (ironic, given the product).
  **Recommendation:** split by verb/domain — `routes/git/{status,diff,stage,commit,push}.ts`; extract `ReviewPane` into `DiffList`, `DiffPanel`, `StagingBar`, `CommitBox` subcomponents; group `api.ts` by route namespace.

- **Error-handling policy is unenforced.** CLAUDE.md mandates `neverthrow`, but only ~5% of fallible code uses `Result<>`. ~589 `try/catch` blocks vs 37 `Result<` usages. Inconsistency means newcomers can't tell what the real convention is.
  **Recommendation:** either (a) narrow the policy — "new code in `core/` and service layers must use Result; route handlers can throw" — or (b) schedule a migration module-by-module starting with `core/src/git/`.

- **Client test coverage is anemic (9% file-to-test ratio).** Zero tests directly cover `ReviewPane` or `VirtualDiff` despite their blast radius.
  **Recommendation:** add Playwright-level coverage for the ReviewPane flow; extract pure diff-math into a testable module.

### MEDIUM

- **Service Locator vs DI.** `service-registry.ts` stores a single `RuntimeServiceProvider` and all services call `getServices()` on demand. Works, but hides dependencies and makes unit-testing services harder (you mock a global).
  **Recommendation:** pass the provider explicitly into service constructors where new code is added; retire the global for new services.

- **Aggregated provider interface (ISP).** Consumers that need only `threadEvents` still depend on the full `RuntimeServiceProvider`. Low urgency, but the provider is a coupling hub.

- **WS broker is a singleton pub/sub with no per-thread fan-out.** Filtering happens client-side by `threadId`. Fine today; a scale-ceiling when many threads stream concurrently. Worth a metric.

### LOW

- **`db/migrate.ts` (1007 lines of raw SQL).** Large by line count but it's an initialization script; acceptable. Would benefit from splitting per table for diffability.
- **`shared/src/db/adapters/sqlite.ts` does `fs.chmodSync`.** A side effect in `shared` is a minor layer smell; acceptable for a DB adapter but document it as an exception.
- **No formal architecture fitness functions in CI.** The graph is clean today; nothing prevents regression.

---

## 7. Tradeoff Analysis

| Decision | Benefits | Costs | Aligned? |
|----------|----------|-------|----------|
| Always split server/runner as two processes | Real multi-tenant + NAT-friendly runners; clear trust boundary | Extra WS hop, duplicated route files, dual-process dev ergonomics | **Yes** — multi-tenant is a stated product goal |
| Single multiplexed `/ws` stream | Simple broker, single reconnect | Client-side filtering; no per-thread backpressure | **Partially** — re-evaluate at scale |
| Runtime also has its own SQLite | Session/PTY persistence survives runtime restart | Two DBs to reason about; some duplication with server | **Yes** — required for session resumption in remote-runner mode |
| Service Locator (`getServices()`) | Fast to wire new handlers | Hidden deps, weaker unit-testability | **Partially** — fine early, friction later |
| `throw`-based errors alongside a written `neverthrow` policy | Pragmatic for Hono handlers | Policy/reality mismatch confuses contributors | **No** — either the policy or the code should change |
| Fat files in client + runtime routes | Rapid iteration | High merge-conflict probability (the product's own worktree workflow is the customer) | **No** — split when touching |

---

## 8. Recommendations (Prioritized)

### Quick Wins (low effort, high impact)

1. **Add `dependency-cruiser` (or ESLint `import/no-restricted-paths`) as a CI fitness function.** Encode the rules: `server → runtime` forbidden; `core → Hono/Drizzle` forbidden; `shared → anything but evflow` forbidden; no file >1500 lines without a waiver.
2. **Extract `packages/client/src/lib/api.ts` into a namespace-per-file module (`api/projects.ts`, `api/git.ts`, ...).** Pure mechanical split, no semantic change, removes a hotspot.
3. **Enable `madge --circular` on `runtime/src`** to catch file-level cycles the package-level check can't see.
4. **Clarify the `neverthrow` policy in CLAUDE.md** to scope it (e.g., "new code in `core/` and runtime services"). Cheap, removes a contributor-confusion tax.

### Strategic Improvements (higher effort, high impact)

1. **Split `runtime/src/routes/git.ts` (2180 lines) into domain sub-routers** (`git/status.ts`, `git/diff.ts`, `git/stage.ts`, `git/commit.ts`, `git/remote.ts`, `git/worktree.ts`). Mirror this in `client/src/lib/api/git/*`.
2. **Decompose `ReviewPane.tsx` (3035 lines)** into `DiffList`, `DiffPanel`, `StagingBar`, `CommitBox`, `PRActions`. Move diff-math into a testable pure module and add unit tests there.
3. **Migrate `core/src/git/*` to `Result<T, GitError>` end-to-end.** It's the right place to start — smallest surface, highest value, already isolated.
4. **Introduce narrower service interfaces (ISP) at the provider boundary.** Instead of handlers receiving `RuntimeServiceProvider`, let them declare the subset they need (`Pick<RuntimeServiceProvider, 'threadEvents'>`).

### Long-term Refactoring (foundational)

1. **Move away from the Service Locator** for new runtime services. Inject dependencies through constructors so tests can substitute doubles without a global reset.
2. **Sharded WS broker** once concurrent-thread load justifies it — per-thread channels with backpressure instead of a single multiplexed stream.
3. **Formalize a package boundary doc** (one page, no prose) codifying: what each package may import, owned route prefixes, owned DB tables. Pair with the dependency-cruiser rules.

---

## 9. Suggested Fitness Functions

Concrete, CI-runnable checks — each maps to a finding above.

| # | Check | Tool | Fails when |
|---|-------|------|-----------|
| 1 | Package layering: `server` must not import from `runtime`; `core` must not import Hono/Drizzle; `shared` must not import from `core`/`runtime` | `dependency-cruiser` | Any forbidden edge appears |
| 2 | No circular imports at file level within `runtime/src` and `core/src` | `madge --circular` | Any cycle introduced |
| 3 | File size ceiling: no source file >1500 lines (waiver list: `db/migrate.ts`) | Custom script / ESLint | A file crosses the threshold |
| 4 | Efferent coupling: `shared` Ce ≤ 1 | Import-graph script | New `@funny/*` import added to shared |
| 5 | `WSEvent` discriminated union exhaustiveness in switch handlers | TS `never`-check in ws-broker | A new event type is added without a handler |
| 6 | `core/src/git/**` returns `Result<>` (no `throw` allowed) | ESLint `no-throw-literal` scoped to path | `throw` introduced in git module |
| 7 | `data-testid` on interactive elements in `packages/client` | ESLint plugin or custom AST check | Button/Input added without `data-testid` (CLAUDE.md rule) |
| 8 | All WS events carry `threadId` | TS type check (already enforced at type level) | Covered; keep in CI |
| 9 | Runner-auth header on all `/api/runner/*` routes | Custom route-audit script | A route is added without auth middleware |

---

**Evaluator's note.** This codebase is in noticeably better architectural shape than typical for its size. The problems it has are the ones that are easy to let grow and hard to unwind later — fat files and a policy that isn't consistently applied. The shape is right; the mass distribution is the thing to work on.
