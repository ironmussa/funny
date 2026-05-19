# Architecture Evaluation Report

**Project:** funny — Claude Agent orchestration UI (Bun monorepo)
**Date:** 2026-05-19 (refresh; supersedes 2026-04-24)
**Evaluation scope:** All workspace packages under `packages/*` (16 packages). Primary focus on the five load-bearing ones: `shared`, `core`, `runtime`, `server`, `client`. Secondary review of `orchestrator`, `pipelines`, `agent`, `reviewbot`, `memory`, `evflow`, plus the orphan/peripheral packages.
**Methodology:** ATAM + SAAM-inspired, ISO 25010 attributes, Martin coupling/instability metrics, blast-radius analysis. Delta-focused against the 2026-04-24 baseline.

---

## 1. Executive Summary

**The structural shape is the best it has ever been; the mass problem has merely shifted addresses.**

Three of the four big recommendations from the 2026-04-24 report have landed:

- **Fitness functions are in CI** — [`scripts/fitness/check-layering.ts`](scripts/fitness/check-layering.ts), [`check-circular.ts`](scripts/fitness/check-circular.ts), [`check-file-size.ts`](scripts/fitness/check-file-size.ts) (plus typecheck + growth budget). They are catching real regressions today.
- **`ReviewPane.tsx` was decomposed** — 3448 → **536 lines**, with a new feature folder [`components/review-pane/`](packages/client/src/components/review-pane/) containing `ChangesFilesPanel`, `ChangesToolbar`, `CommitDraftPanel`, `DiffViewerModal`, `ReviewActionDialogs`, `ReviewChangesTab`, `ReviewDialogs`, `StashTab`. A 2900-line drop in one file is the single biggest architectural win of this cycle.
- **`routes/git.ts` and `routes/github.ts` were split** — both files are now ~30-line index files re-exporting a sub-router tree ([`routes/git/`](packages/runtime/src/routes/git/) and [`routes/github/`](packages/runtime/src/routes/github/)).
- **`shared/src/types.ts` was split** — 1897 → 724 lines + a [`types/`](packages/shared/src/types/) directory with 16 domain files (`agent-templates`, `auth`, `git`, `github`, `mcp`, `pipelines`, etc.).
- **`client/lib/api.ts` was split** — 1766 → 46-line index over a typed `api/` module tree with `_core.ts` (neverthrow-based) plus one file per domain.

What got worse since 2026-04-24:

- **A new package-internal circular import** between [`stores/ui-store.ts`](packages/client/src/stores/ui-store.ts) and [`stores/thread-store.ts`](packages/client/src/stores/thread-store.ts) — the fitness check is **currently failing** on `master` (see Finding HIGH-1).
- **`TerminalPanel.tsx` (1532)** crossed the 1500-line ceiling; its size waiver has not been added, so the file-size fitness check is **currently failing**.
- **`@funny/shared` boundary has drifted further from "leaf types"** — now hosts the entire database access layer (schema for sqlite + pg, adapters, migrations, factory-pattern repositories). The architectural CLAUDE.md description ("TypeScript types and error definitions, no runtime code") is no longer accurate. This is not necessarily wrong, but it needs to be acknowledged and re-scoped (see Finding HIGH-3).
- **The `neverthrow` policy is now scoped in CLAUDE.md** (good) **but `core/**` still throws in 36 places across 16 files** (bad). The mandate text is correct; the codebase has not caught up.
- **The runtime `services/` directory has grown to 61 top-level files.** Even with a real DI provider keeping the layering clean, navigating 61 service modules requires a folder structure the package does not yet have.
- **Workspace surface area has grown to 16 packages** including several orphans with zero internal consumers: `@funny/memory`, `@funny/design-client`, `@funny/chrome-extension`, `@funny/api-acp`. Dead packages are a maintenance tax that compounds.

Top three actions: (1) **fix the failing fitness checks today** — the `ui-store ↔ thread-store` cycle and `TerminalPanel` waiver are CI blockers as-of this evaluation; (2) **re-baseline the package boundary doc**: either re-label `@funny/shared` as the data-access kernel (and rename it to match), or extract `@funny/db` to restore the original "leaf types only" promise; (3) **decide on the orphan packages** — fold, version-pin, or document them as side projects.

---

## 2. Architecture Overview

- **Project type:** Local-first web app + remote-runner multi-tenant mode + Tauri desktop build + `bunx funny` CLI. The product is a UI for orchestrating multiple Claude Code agents in parallel using git worktrees.
- **Stack:** TypeScript on Bun. Hono (HTTP), Drizzle ORM over SQLite/Postgres, Socket.IO (server↔runner tunnel + browser broadcast), React 19 + Vite + Zustand + shadcn/ui (Radix). `@anthropic-ai/claude-agent-sdk` for agent execution. Better Auth for sessions. neverthrow for `Result`-based error handling. Playwright for E2E.
- **Architecture style:** **Modular monolith with a detachable, stateless runner** plus an out-of-process orchestrator. Data plane is `Client → Server → Runner` over a Socket.IO tunnel. The runner has no database; all persistence is proxied to the server via `RuntimeServiceProvider` (a real DI port, not a service locator).
- **Entry points:** [`packages/server/src/index.ts`](packages/server/src/index.ts) (384 lines), [`packages/runtime/src/index.ts`](packages/runtime/src/index.ts) (136 lines), [`packages/orchestrator/src/bin/orchestrator.ts`](packages/orchestrator/src/bin/orchestrator.ts), [`bin/funny.js`](bin/funny.js) (CLI).

### 2.1 Verified package graph (2026-05-19)

Re-derived from `package.json` workspace deps + actual import scan:

```
                            evflow ←─────────────────────────────────────┐
                              ▲ (1 type-only import from shared)         │
                              │                                          │
                         native-git                                      │
                              ▲                                          │
                              │                                          │
shared (10 dependents) ──┬──→ evflow                                     │
   │ types + DB + auth + repositories + thread-machine                   │
   ▼                                                                     │
core ───→ shared + native-git           (no hono, no drizzle ✓)          │
   │ git/, agents/, containers/, orchestrator/, ports/, symbols/         │
   ▼                                                                     │
runtime ───→ core + shared + pipelines + thread-orchestrator             │
   │ Hono routes, 61 services, agent runners, PTY, ws-broker, automation │
   │                                                                     │
server ───→ core + shared + thread-orchestrator + runtime (declared,     │
   │        unused at the moment — see Finding LOW-2)                    │
   │ auth, DB, project-manager, runner-manager, socketio hub             │
   ▼                                                                     │
client ───→ shared (types-only consumption, verified — see §6 Q5)        │
   │ React 19 SPA; /api over HTTP + /socket.io over WS                   │
```

**Peripheral / orphan packages:**

| Package | Status | Internal consumers |
|---------|--------|--------------------|
| `@funny/memory` | Orphan | None (only references are inside the package itself) |
| `@funny/design-client` | Orphan | None |
| `@funny/chrome-extension` | Orphan | None |
| `@funny/api-acp` | Orphan | None |
| `@funny/sdk` | Used by `agent` + `reviewbot` + `chrome-extension` | Internal |
| `@funny/orchestrator` (= `packages/agent`) | Standalone reviewer bot | Not imported by runtime/server |
| `@funny/reviewbot` | Standalone | Not imported by runtime/server |

> ⚠️ The package directory `packages/agent/` has the `name` field `@funny/orchestrator`, while `packages/orchestrator/` is named `@funny/thread-orchestrator`. This is genuinely confusing: any reader who maps directory names to package names will be misled. See Finding MEDIUM-3.

### 2.2 Layering rules in effect

Documented in two places that agree (good):

- [`scripts/fitness/check-layering.ts`](scripts/fitness/check-layering.ts): `server` ⇸ `runtime`, `core` ⇸ `hono`/`drizzle-orm`, `shared` ⇸ `core`/`runtime`.
- [`.sentrux/rules.toml`](.sentrux/rules.toml): `shared` ⇸ `core`, `core` ⇸ `runtime`, `client` ⇸ `server`.

All of these pass today (verified by running `bun scripts/fitness/check-layering.ts` → `layering ok — all package boundaries respected`).

---

## 3. Quality Attribute Scorecard

| Attribute | Score | Trend | Key finding |
|-----------|:----:|:----:|-------------|
| Modifiability | **3/5** | ↑ | SRP score improved (ReviewPane/api/types/git-routes/github-routes all split). Still: 13 files in the 1000–1500 range; one is over the ceiling; `services/` is a flat 61-file directory. |
| Performance | 3/5 | → | No evidence of new N+1 patterns. Single multiplexed `/socket.io` channel; runtime → server tunnel does per-call HTTP encoding (overhead is real but the layering value is real too). |
| Testability | 3/5 | → | 191 test files across 12 `__tests__/` dirs. Runtime + server backend coverage is solid; client coverage proportionally remains the thinnest. DI in runtime is genuinely usable; routes don't touch DB. |
| Deployability | 4/5 | → | Server/runner separation intact and load-bearing. Runner is stateless; server is the only stateful node. Single `bunx funny` CLI; Tauri desktop build; Railway + Docker recipes present. |
| Security | 4/5 | ↑ | Full OWASP audit pass landed since the last report (`SECURITY_AUDIT_TASKS.md` C1–C10 + H1–H5 + M-series all marked done). Per-user runner isolation still enforced. CSP scriptSrc strict, styleSrc 'unsafe-inline' documented as known limit. |
| Reliability | 3/5 | → | `neverthrow` mandate is now scoped (CLAUDE.md says: required in `core/**`, required at runtime/server **service method boundaries**, allowed to throw in Hono handlers + tests). Reality: 36 throws in `core/`, 135 in `runtime/services/` — policy ahead of implementation. WS broker still a single coordination point. |

**Overall Architecture Health: 3.3 / 5** (was 3.2). Modifiability ↑ recovers most of the gap; Reliability holds; Security ↑ from the audit. The mass problem moved but did not leave.

---

## 4. Dependency Analysis

### 4.1 Package coupling (Martin metrics, package-level)

Built from `package.json` workspace links + verified by import scan:

| Package | Ca (in) | Ce (out) | I = Ce/(Ca+Ce) | Files | Source LOC | Notes |
|---------|:------:|:-------:|:-------------:|:-----:|:----------:|-------|
| `shared` | **10** | 1 | **0.09** | 44 | 8,512 | Maximally stable. Now hosts DB + repositories (boundary drift, see HIGH-3). |
| `core` | 5 | 2 | 0.29 | 71 | 15,162 | Stable. No HTTP, no DB. Hosts git ops + agent process providers. |
| `runtime` | 1 | 4 | 0.80 | 164 | 36,346 | Correctly high-I consumer. 61-file flat `services/` dir. |
| `server` | 0 | 4 | 1.00 | 54 | 12,945 | Terminal layer; HTTP/auth/DB/Socket.IO. |
| `client` | 0 | 1 | 1.00 | 508 | 101,268 | Terminal layer; heaviest file mass in the repo by far. |
| `orchestrator` (thread-orch.) | 2 | 3 | 0.60 | 12 | 1,657 | Used by server + runtime. |
| `pipelines` | 2 | 0 | 0.00 | 7 | 1,171 | Pure leaf, no internal deps. |
| `agent` (= `@funny/orchestrator`) | 0 | 3 | 1.00 | 35 | 4,246 | Standalone reviewer; orphan-ish (not consumed by main app). |
| `sdk` | 3 | 0 | 0.00 | 3 | 490 | Tiny leaf. |
| `reviewbot` | 0 | 3 | 1.00 | 7 | 761 | Standalone. |
| `memory` | 0 | 0 | — | 15 | 3,372 | Orphan. |
| `evflow` | 1 | 0 | 0.00 | 16 | 3,278 | Leaf, used by shared only. |
| `api-acp` | 0 | 1 | 1.00 | 7 | 1,008 | Orphan. |
| `chrome-extension` | 0 | 2 | 1.00 | 5 | 3,785 | Orphan. |
| `design-client` | 0 | 1 | 1.00 | — | — | Orphan; no Bun src layout. |
| `native-git` | 0 | 0 | — | (Rust) | (Rust) | Native binding crate. |

**Distance from Main Sequence (D = |A + I − 1|):**

- `shared` — I=0.09, mostly stable, but it now mixes type definitions (highly abstract, good) with concrete DB/repository implementations (not abstract). Effective abstractness has dropped. **Drifting toward the Zone of Pain** (stable + concrete + many dependents). The repositories are factory-pattern though, which mitigates this somewhat.
- `runtime` — I=0.80, large concrete consumer, fewer abstractions. Correct position on the main sequence; just heavy.
- `client`/`server` — I=1.00, terminal layers, by design.
- The `agent`, `reviewbot`, `memory`, `api-acp`, `chrome-extension`, `design-client` packages all have **Ca = 0** — they are either standalone tools or dead code. See Finding MEDIUM-2.

### 4.2 Internal coupling inside `runtime/services/`

From an Explore-agent pass over the 61-file service directory (efferent coupling = distinct `import` statements):

| File | Ce (internal imports) | Role |
|------|:---:|------|
| `agent-lifecycle.ts` (524 LOC) | 15 | Orchestrates agent startup, context recovery, MCP loading, status machine transitions |
| `pipeline-adapter.ts` (578 LOC) | 14 | Bridges pipelines DSL and runtime services |
| `git-pipelines.ts` (1230 LOC) | 12 | Composes reusable pipeline nodes from `@funny/core/git` |
| `agent-message-handler.ts` (883 LOC) | 10 | Deserialises CLI messages, persists, emits |
| `git-service.ts` (542 LOC) | 10 | High-level git operations |
| `mcp-service.ts` (535 LOC) | 9 | MCP server loader |
| `ingest-mapper.ts` (1108 LOC) | 9 | Multipart payload → DB |
| `pty-manager.ts` (732 LOC) | 9 | PTY session multi-backend orchestration |
| `test-runner.ts` (861 LOC) | 8 | Test-mode agent execution + pipeline approval |
| `team-client.ts` (1379 LOC) | 8 | Runner↔server Socket.IO tunnel |

**Verdict:** No god classes in the antipattern sense — high coupling here tracks legitimate orchestration responsibilities (the message-handler / event-router / state / lifecycle / runner split is clean). The pain point is **navigability**, not coupling: 61 service files at one level of nesting with no subfolders is a discoverability problem in its own right. Compare `routes/`, which is now subdivided into `git/`, `github/`, `projects/`.

### 4.3 Circular dependencies

Package-level: **none.** File-level: **one new cycle**, currently failing CI.

```
packages/client/src/stores/ui-store.ts
   ↓ imports useThreadStore, invalidateSelectThread  (line 4)
packages/client/src/stores/thread-store.ts
   ↓ imports useUIStore                              (line 75)
   ↓ uses useUIStore.setState({...})                (line ~405)
```

This is not fixable by moving a type — it is a runtime cycle. The two stores need to exchange side-effects (thread close clears UI state; UI selection invalidates thread query). The known-cycle baseline in [`check-circular.ts`](scripts/fitness/check-circular.ts#L139-L151) already documents one intentional React render-tree cycle (`ToolCallCard ↔ ToolCallGroup ↔ TaskCard`) — this new cycle is not yet listed and therefore fails the fitness check.

### 4.4 Blast radius (top modules by change-impact)

| Module | Lines | Δ vs 2026-04-24 | Blast radius | Why |
|--------|:-----:|:---:|--------------|-----|
| `shared/src/types.ts` | **724** | −1173 | High | Re-exports the entire `types/` tree; every consumer depends transitively. The drop is real progress. |
| `shared/src/db/schema.ts` | (many) | new since drift | **Very High** | Schema for both sqlite and pg. Any DB consumer reads it. |
| `client/components/TerminalPanel.tsx` | **1532** | new violator | High | Single-file PTY UI; CI-failing. |
| `client/components/PromptInputUI.tsx` | 1456 | — | High | Prompt staging + model selection + attachments + voice. |
| `runtime/services/team-client.ts` | 1379 | +186 | **Very High** | Runner↔server protocol implementation. Any tunnel change passes through. |
| `client/stores/thread-store.ts` | 1248 | +114 | **Very High** | Active thread state hub. Co-edit magnet. |
| `runtime/services/git-pipelines.ts` | 1230 | new | High | Pipeline node composition for git ops. |
| `client/components/prompt-editor/PromptEditor.tsx` | 1196 | — | Medium | Rich editor, mostly self-contained. |
| `client/components/test-runner/TestDetailTabs.tsx` | 1193 | — | Medium | Test viewer. |
| `server/src/db/migrate.ts` | 1176 | — | High | Hand-rolled migration SQL (no Drizzle migrations); every schema change passes through. |
| `client/components/tool-cards/ExpandedDiffDialog.tsx` | 1148 | — | Medium | Diff dialog. |
| `runtime/services/ingest-mapper.ts` | 1108 | — | High | DB-bound; large mapper. |
| `client/components/thread/ProjectHeader.tsx` | 1121 | — | Medium | UI chrome + branch state. |
| `client/components/settings/AgentTemplateSettings.tsx` | 1095 | — | Medium | Form UI. |
| `core/src/agents/gemini-acp.ts` | 1025 | — | Medium-High | One of four ACP provider implementations. |
| `client/stores/thread-ws-handlers.ts` | 1007 | — | High | WS event handlers; couples WS to thread state. |
| `shared/src/runner-protocol.ts` | (smaller, but) | — | **Very High** | Tunnel contract between runtime and server. |

---

## 5. Design Principle Adherence

| Principle | Score | Notable evidence |
|-----------|:----:|-------------------|
| SRP | **3/5** (↑ from 1) | Big-fat-file reductions landed (ReviewPane, types, api, git routes, github routes). But TerminalPanel/PromptInputUI/team-client/thread-store remain in the 1000–1500 range. |
| OCP | 4/5 | Agent-provider registry (`registerProvider`) genuinely extensible. PTY backends are pluggable (`pty-backend-{bun,daemon,headless,node-pty,null,tmux}.ts`). |
| DIP | 4/5 | `RuntimeServiceProvider` is a real dependency-injection port, set once in `service-registry.ts`, accessed via `getServices()` in 17 services and most routes. Routes never import DB directly. |
| ISP | 3/5 | Handlers still take the full `RuntimeServiceProvider` instead of narrow sub-ports. A handler that only needs `threadEvents` still depends on `mcpOauth`, `analytics`, etc. — change-propagation hazard. |
| Law of Demeter | 3/5 | The fat React components reach into Zustand store internals; `thread-store.ts` (1248) is a hub many components dot-walk into (`useThreadStore.getState().messages[...]`). |
| Contracts | 5/5 | `WSEvent` discriminated union enforced at the type level; `runner-protocol.ts` is the explicit, versioned tunnel contract. |

### 5.1 `neverthrow` policy vs reality

CLAUDE.md now says (correctly scoped):

> **Required** in `packages/core/**` — all fallible functions MUST return `Result<T, E>` / `ResultAsync<T, E>`. No raw `throw` in new code under `core`.
> **Required at service-method boundaries** in `packages/runtime/src/services/**` and `packages/server/src/services/**`.
> **Allowed to `throw`**: Hono route handlers, top-level entry points, test code.

Verified counts (excluding tests):

| Package | `throw new …` count | Files with throws | `Result`/`ResultAsync` usage sites |
|---------|:---:|:---:|:---:|
| `core` | **36** | 16 | 402 |
| `runtime` services | **97** (135 total in package) | 27 | 70 |
| `server` | 10 | 4 | (via Hono boundaries) |
| `client` | 11 | 8 | (preferred but not required) |

The mandate is broken in `core` (36 raw throws in 16 files, including [`git/worktree.ts`](packages/core/src/git/worktree.ts), [`git/github.ts`](packages/core/src/git/github.ts), [`git/stage.ts`](packages/core/src/git/stage.ts), [`agents/codex-acp.ts`](packages/core/src/agents/codex-acp.ts), [`agents/pi-acp.ts`](packages/core/src/agents/pi-acp.ts), [`ports/port-allocator.ts`](packages/core/src/ports/port-allocator.ts)). These are existing throws — not new code — but the CLAUDE.md text reads "no raw throw in new code under `core`", which is the policy a reviewer will use to gate the next PR. The existing throws need to either be (a) migrated, or (b) explicitly excepted in the policy text.

---

## 6. Findings

### CRITICAL

_None._ No package-layering violations. Per-user runner isolation enforced. WS tunnel contract typed end-to-end. Security audit (C1–C10) closed since the last evaluation.

### HIGH

- **HIGH-1. Failing fitness check #1 — `ui-store ↔ thread-store` cycle.** [`bun scripts/fitness/check-circular.ts`](scripts/fitness/check-circular.ts) currently exits non-zero on `master` because of a new file-level cycle between [`packages/client/src/stores/ui-store.ts`](packages/client/src/stores/ui-store.ts) (imports `useThreadStore` + `invalidateSelectThread`) and [`packages/client/src/stores/thread-store.ts`](packages/client/src/stores/thread-store.ts) (imports `useUIStore`). This is a runtime cycle, not a type-only one. **Impact:** CI is red; the architectural guardrail is being routed around informally. **Recommendation:** extract the two cross-store side-effects (thread-close→clear UI state, UI selection→invalidate thread) into a tiny `stores/cross-store-effects.ts` module that imports both stores but is not imported back by either. This breaks the cycle without changing behaviour.

- **HIGH-2. Failing fitness check #2 — `TerminalPanel.tsx` exceeds 1500-line ceiling.** [`bun scripts/fitness/check-file-size.ts`](scripts/fitness/check-file-size.ts) reports `packages/client/src/components/TerminalPanel.tsx: 1533 lines (limit 1500)`. **Impact:** CI red. **Recommendation:** either decompose (extract `TerminalToolbar`, `TerminalTabBar`, `TerminalSessionView`, the `terminal-spawn-machine` orchestration), or — if no time — add an explicit waiver with a decomposition plan, mirroring the pattern already used for `shared/src/evflow.model.ts`.

- **HIGH-3. `@funny/shared` boundary has drifted from "types-only".** The package now contains [`db/schema.ts`](packages/shared/src/db/schema.ts), [`db/schema.sqlite.ts`](packages/shared/src/db/schema.sqlite.ts), [`db/schema.pg.ts`](packages/shared/src/db/schema.pg.ts), [`db/adapters/{sqlite,pg}.ts`](packages/shared/src/db/adapters/), [`db/migrate.ts`](packages/shared/src/db/migrate.ts), [`db/connection.ts`](packages/shared/src/db/connection.ts), and [`repositories/{message,thread,tool-call,comment,design,orchestrator-run,stage-history}.ts`](packages/shared/src/repositories/). Server and orchestrator both consume the repositories. Runtime does not (it proxies via DI), so layering is technically intact, but: [CLAUDE.md](CLAUDE.md) line 58 still describes `packages/shared` as "TypeScript types and error definitions (no runtime code)", which is no longer true. **Impact:** the package's role is invisible to a new contributor — they will either (a) over-import from it (because "shared" sounds free) or (b) be surprised it carries Drizzle. The abstractness (A) has fallen, pushing it toward the Zone of Pain. **Recommendation:** rename to `@funny/kernel` or `@funny/core-data`, OR extract `@funny/db` as a sibling package containing schema/adapters/repositories. Update CLAUDE.md to match reality regardless of which path you pick.

- **HIGH-4. `core` policy says "no raw throw"; `core` has 36 raw throws across 16 files.** The CLAUDE.md mandate is now correctly scoped, but the existing throws (in [`git/worktree.ts`](packages/core/src/git/worktree.ts), [`git/github.ts`](packages/core/src/git/github.ts), [`git/stage.ts`](packages/core/src/git/stage.ts), [`git/path-validation.ts`](packages/core/src/git/path-validation.ts), [`agents/codex-acp.ts`](packages/core/src/agents/codex-acp.ts), [`agents/pi-acp.ts`](packages/core/src/agents/pi-acp.ts), [`agents/deepagent-process.ts`](packages/core/src/agents/deepagent-process.ts), [`agents/resolve-sdk-cli.ts`](packages/core/src/agents/resolve-sdk-cli.ts), [`agents/llm/model-factory.ts`](packages/core/src/agents/llm/model-factory.ts), [`containers/sandbox-manager.ts`](packages/core/src/containers/sandbox-manager.ts), [`ports/port-allocator.ts`](packages/core/src/ports/port-allocator.ts)) were never converted. **Impact:** reviewers reading "no raw throw in new code" will assume the rest is `Result`-shaped, and copy bad patterns. **Recommendation:** start with `git/**` — the smallest, highest-value subset — and migrate to `Result<T, GitError>` end-to-end. Add a scoped ESLint `no-throw-literal` for `packages/core/src/git/**` once done, then expand outwards.

### MEDIUM

- **MEDIUM-1. `runtime/services/` is a 61-file flat directory.** This is the highest-traffic surface in the codebase (every backend feature lands here) and it has no folder structure. The agent-related files (`agent-runner.ts`, `agent-lifecycle.ts`, `agent-message-handler.ts`, `agent-event-router.ts`, `agent-state.ts`, `agent-registry.ts`, `agent-startup/*`) could move under `services/agent/`. The PTY family (`pty-manager.ts`, `pty-backend.ts`, `pty-backend-*.ts`, `pty-daemon.ts`, `pty-daemon-launcher.ts`) under `services/pty/`. The pipeline family (`pipeline-adapter.ts`, `pipeline-manager.ts`, `pipeline-prompts.ts`, `pipeline-approval-store.ts`, `orchestrator-pipeline-*.ts`, `git-pipelines.ts`) under `services/pipeline/`. The `routes/` tree already does this — adopt the same pattern.

- **MEDIUM-2. Six orphan packages.** `@funny/memory` (15 files, 3.3k LOC), `@funny/design-client`, `@funny/chrome-extension` (5 files, 3.8k LOC), `@funny/api-acp` (7 files, 1.0k LOC), `@funny/reviewbot`, plus the standalone `@funny/orchestrator` (= `packages/agent/`, 35 files, 4.2k LOC) have zero consumers inside the main runtime/server/client triangle. They may be intentional side projects, prototypes, or pending integrations — but right now they pay the workspace tax (install, lint, type-check) without delivering. **Recommendation:** classify each as (a) **active side project** — document in `README.md` and add to `npm test`/CI; (b) **archive** — move to `_archive/` or a separate repo; (c) **integration in progress** — track in `openspec/` with an explicit milestone.

- **MEDIUM-3. `@funny/orchestrator` is the name of two different things.** [`packages/agent/package.json`](packages/agent/package.json) declares `"name": "@funny/orchestrator"`, while [`packages/orchestrator/package.json`](packages/orchestrator/package.json) declares `"name": "@funny/thread-orchestrator"`. A reader looking at the directory tree (`packages/agent/`, `packages/orchestrator/`) will pick the wrong file every time. Rename the `packages/agent/` package to something that matches its purpose (reviewer bot? developer-agent harness?), or rename the directory to match the package name.

- **MEDIUM-4. `RuntimeServiceProvider` is wide — ISP at the boundary.** Every handler that takes `services` gets all 12 ports: `projects`, `threads`, `automations`, `pipelines`, `profile`, `analytics`, `search`, `startupCommands`, `threadEvents`, `messageQueue`, `mcpOauth`, `stageHistory`, `wsBroker`. **Impact:** mocking in unit tests means stubbing 12 things, and changes to any port ripple unnecessarily. **Recommendation:** narrow at call-sites using TypeScript `Pick<RuntimeServiceProvider, ...>` (no runtime cost). Update the most-touched services first.

- **MEDIUM-5. `runtime/services/team-client.ts` (1379 LOC) and `client/stores/thread-store.ts` (1248 LOC) both grew this cycle.** They were called out last time; they got bigger, not smaller. They are not yet decomposed. The store could be split into `thread-store` + `thread-actions` + `thread-selectors`; the team-client into `team-client/{register,heartbeat,tunnel,events}.ts`.

- **MEDIUM-6. The hand-rolled migration runner in [`packages/server/src/db/migrate.ts`](packages/server/src/db/migrate.ts) (1176 lines) is a single file managing every schema change ever.** Drizzle migrations are deliberately not used (per CLAUDE.md). This is the right call for an embedded SQLite app — but the file size keeps growing linearly with schema age and there is no formal "squash baseline" event. **Recommendation:** at the next major version cut, baseline the schema (current shape) and reset `migrate.ts` to migrations forward from there.

### LOW

- **LOW-1. Server declares `@ironmussa/funny-runtime` in `dependencies` but does not import it.** `grep -r '@ironmussa/funny-runtime' packages/server/src` returns zero matches. The dependency was likely added during the server/runner split refactor and never removed. Cosmetic, but it makes the workspace graph noisier than reality. **Recommendation:** delete from [`packages/server/package.json`](packages/server/package.json).

- **LOW-2. `packages/server/CLAUDE.md` points readers at the logger in `packages/runtime/src/lib/logger.ts`** — but the server already has its own [`packages/server/src/lib/logger.ts`](packages/server/src/lib/logger.ts) that mirrors the runtime pattern. The doc is stale. **Recommendation:** update the server CLAUDE.md to reference the local logger.

- **LOW-3. Naming inconsistency: `@funny/*` vs `@ironmussa/*`.** Published packages live under `@ironmussa/funny-runtime` and `@ironmussa/funny`, internal-only packages under `@funny/*`. This is a deliberate split (private vs public publishing) but is undocumented anywhere a contributor would see. **Recommendation:** one sentence in the root README.

- **LOW-4. `shared/src/evflow.model.ts` (1457 lines)** sits at the file-size waiver target. It is generator-shaped DSL output and should not grow further — explicit waiver note in `check-file-size.ts` already says so. Tracked, not urgent.

- **LOW-5. 13 files in the 1000–1500-line band.** All under the ceiling, all blockers for future feature work. The trend is what matters: `thread-store` and `team-client` are climbing.

---

## 7. Tradeoff Analysis

| Decision | Benefits | Costs | Aligned with goals? |
|----------|----------|-------|--------------------|
| **Always-split server/runner**, runtime stateless, all DB access proxied via `RuntimeServiceProvider` over WS | Real multi-tenant; NAT-friendly; clear trust boundary; runner is replaceable per-user | Extra WS hop on every persistent op; tunnel implementation cost in `team-client.ts` (1379 LOC); the tunnel itself is a single point of complexity | **Yes** — core product constraint (each user's runner stays on their machine). |
| **Single multiplexed `/socket.io` channel** with client-side filtering by `threadId` | Simple broker, one reconnect path, predictable failure mode | No per-thread backpressure; fan-out spikes hit every client | **Partially** — add a `threadId`-cardinality metric before scale. Pragmatic today. |
| **`@funny/shared` hosts DB schema + repositories** | One source of truth for the contract between server and orchestrator; both can swap drivers (sqlite/pg) without redefining tables | "Shared" no longer means "types only"; abstractness fell; new contributors mis-scope what belongs there | **Drifted** — see HIGH-3. The decision is defensible but undocumented. |
| **Service-Locator-style DI** (`setServices` once, `getServices()` everywhere) | Fast to wire; no constructor plumbing; small DI footprint | Global mutable singleton complicates per-test isolation; hidden deps; encourages "just `getServices()` it" everywhere | **Fine today, friction later.** Acceptable while the runtime owns one tenant's state. |
| **Hand-rolled SQL migrations** in `server/db/migrate.ts` (1176 LOC) | No Drizzle migration tooling burden; one place to grep; works for SQLite + PG | File grows linearly with schema age; no squash baseline | **Yes** — but plan a baseline for v1.0. |
| **Two database dialects (SQLite default, optional Postgres)** | Local-first by default, scales out via DATABASE_URL | Every repository must work both ways; schema lives in `schema.sqlite.ts` + `schema.pg.ts` | **Yes** — product constraint (run locally with zero infra). |
| **Multi-provider agent abstraction** (Claude SDK, Codex, Gemini ACP, π-ACP, deepagent, LLM API in `core/agents/`) | OCP win; new providers plug in via `process-factory.ts` | Maintaining six provider modules; the smallest (e.g. `gemini-acp.ts` is 1025 LOC) carry provider-specific quirks | **Yes** — product is explicitly multi-agent. |
| **16 workspace packages** including six orphans | Each is independently versionable; future-proofs splitting out memory/extension/etc. | Install graph noise; six packages pay CI cost for zero internal consumers | **Drifted** — see MEDIUM-2. |
| **Let `team-client.ts` and `thread-store.ts` grow as features land** | Fastest feature throughput; centralised state | Co-edit hotspots; tunnel/store logic interleaved with feature glue | **No** for `thread-store` (Zustand hubs are easy to split); **acceptable** for `team-client` until the protocol stabilises. |

---

## 8. Recommendations (Prioritized)

### Quick Wins (low effort, high impact)

1. **Fix `bun run fitness` to green.** Resolve the `ui-store ↔ thread-store` cycle (extract a `cross-store-effects.ts` module) and add a waiver entry for `TerminalPanel.tsx` (or split it). One day of work; restores CI signal.
2. **Update CLAUDE.md to describe `@funny/shared` accurately.** Two-line edit. Mentions that DB schema, adapters, migrations, and repositories live there; flags that runtime does not consume them (uses DI).
3. **Delete `@ironmussa/funny-runtime` from `packages/server/package.json` dependencies** — unused.
4. **Fix `packages/server/CLAUDE.md`** to reference the local logger instead of the runtime one.
5. **Add a `packages/agent` → directory rename** (or change its `name` field) so it no longer collides conceptually with `packages/orchestrator`.
6. **Tag the orphan packages.** Add a `status: side-project | archive | wip` field to each orphan's `package.json` `description`, and list them in the root README.

### Strategic Improvements (medium effort, high impact)

1. **Decompose `client/stores/thread-store.ts` (1248 LOC)** into `thread-store` (state) + `thread-actions` (mutations) + `thread-selectors` (derived reads). Move the `useUIStore.setState` cross-call out as part of HIGH-1.
2. **Subdivide `packages/runtime/src/services/`** into `agent/`, `pty/`, `pipeline/`, `git/`, `mcp/`, `team/`, mirroring the `routes/` reorg. Pure file moves; no behaviour changes. Cuts the discoverability cost.
3. **Migrate `core/src/git/**` end-to-end to `Result<T, GitError>`.** Smallest scope, highest value, already isolated. Builds the muscle for the broader `neverthrow` rollout under `core`.
4. **Add `Pick<RuntimeServiceProvider, ...>` to the five most-called services** (e.g. `agent-message-handler` only needs `threads, messageQueue, threadEvents`). Zero runtime change; cuts the dependency footprint visible in unit tests.
5. **Pick a decision on `@funny/shared` drift.** Either rename (`@funny/kernel`) or extract a `@funny/db` package. Document the choice.

### Long-term Refactoring (foundational)

1. **Retire the Service Locator pattern for new services.** New runtime services should accept their dependencies via constructor or argument. Existing services keep working; the locator stays available for legacy.
2. **Sharded WS broker** once concurrent-thread load demands it. Today's single-multiplex stream is fine; instrument first, refactor only when the metric demands it.
3. **One-page `docs/architecture.md`** pinning: package boundaries, owned route prefixes, owned DB tables, who-imports-whom, the runner-isolation invariant. Make it the canonical reference; link from CLAUDE.md.
4. **Baseline the migration file at v1.0.** When the schema stabilises enough to cut a real release, freeze the migration history into a single "v1 baseline" SQL and re-start `migrate.ts` from there.
5. **Decide on the orchestrator vs reviewbot vs agent split.** Three packages with overlapping reviewer-style responsibilities is at least one too many.

---

## 9. Suggested Fitness Functions

Existing checks (from [`scripts/fitness/`](scripts/fitness/)) and what's missing:

| # | Check | Tool | Fails when | Status |
|---|-------|------|-----------|:------:|
| 1 | Package layering (`server` ⇸ `runtime`; `core` ⇸ `hono`/`drizzle`; `shared` ⇸ `core`/`runtime`) | [`check-layering.ts`](scripts/fitness/check-layering.ts) | Forbidden edge appears | ✅ **Landed** |
| 2 | No new file-level cycles in `core`/`runtime`/`server`/`client` (with known-cycle baseline) | [`check-circular.ts`](scripts/fitness/check-circular.ts) | Any cycle introduced beyond the baseline | ✅ **Landed** (failing today — see HIGH-1) |
| 3 | Source file ≤1500 lines, with explicit waivers | [`check-file-size.ts`](scripts/fitness/check-file-size.ts) | File crosses ceiling without waiver | ✅ **Landed** (failing today — see HIGH-2) |
| 4 | File-growth budget: no PR may push a >1500-line file further past its waiver | [`check-file-growth.ts`](scripts/fitness/check-file-growth.ts) | Waiver-listed file grows | ✅ **Landed** |
| 5 | Typecheck regressions | [`check-typecheck.ts`](scripts/fitness/check-typecheck.ts) | Type errors increase | ✅ **Landed** |
| 6 | Sentrux quality floor (modularity, redundancy, max file/fn lines, no god files) | [`.sentrux/rules.toml`](.sentrux/rules.toml) | Constraints breached | ✅ **Landed** |
| 7 | `core/src/git/**` returns `Result` (no `throw`) | ESLint scoped `no-throw-literal` + `no-restricted-syntax` for `ThrowStatement` | `throw` appears under `core/src/git` | **Missing — add when migration starts** |
| 8 | `shared` has no `@funny/core` or `@funny/runtime` import | already in `check-layering.ts` | Forbidden | ✅ Landed |
| 9 | `WSEvent` exhaustive handling | TS `never`-check in `ws-broker.ts` | New event variant unhandled | ✅ Enforced at type level |
| 10 | Runner-auth header on `/api/runners/*` and proxy paths | Custom route audit | Route added without auth middleware | **Missing — recommended** |
| 11 | Interactive elements carry `data-testid` (CLAUDE.md UI rule) | ESLint custom AST rule on `.tsx` files | Button/Input lacks attribute | **Missing — recommended** |
| 12 | Orphan-package guard — each `packages/*/package.json` must have at least one internal consumer OR carry `status: side-project|archive` | Custom workspace-graph script | New orphan introduced silently | **New, recommended** |
| 13 | `RuntimeServiceProvider` boundary — services in `runtime/src/services/` may not import `@funny/shared/db/connection` directly | Custom import-graph script | Direct DB import bypassing DI | **New, recommended** |
| 14 | `throw` budget per package: `core/**` ≤ N throws (current floor: 36; ratchet down) | Custom AST check, decreasing baseline | Throw count regresses | **New, recommended for HIGH-4** |

The existing six fitness checks are the single biggest architectural improvement since the last evaluation — they are doing their job (two of them are red right now, which is exactly the signal we want them to send). The recommendations above add coverage for the surfaces that drifted this cycle.

---

**Evaluator's note.** The architecture has demonstrably improved in the cycle since 2026-04-24: the four biggest known offenders (ReviewPane, git routes, github routes, types.ts) were all decomposed, and the fitness functions that the previous report begged for actually shipped and are catching real problems. The new failure mode is a different one: **CI is red today because the safeguards work**, not because they don't. The remaining mass is concentrated in client UI surfaces (TerminalPanel, PromptInputUI, prompt-editor) and one cross-cutting state hub (thread-store) — each of which is a tractable two-week project. The structural risks have all migrated up the stack from "bad layering" to "drifted contracts and ambiguous package roles" — which is what good architectural evolution actually looks like.
