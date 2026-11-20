# Proposal

## Why

A cross-package audit (client, runtime, server, shared, core, and the workspace layout) found roughly 16k lines of unreachable code, a dozen hand-maintained duplications that have already drifted (e.g. `projects.closed` exists in the SQLite schema but not the Postgres one), and several latent bugs hiding inside that duplication — including GitHub routes that load a project without checking the caller may access it, and background subagents being auto-denied tool permission once the main agent turn ends. Fixing the duplication at its source (registries, factories, shared middleware) removes code _and_ closes the bug classes, so the work is done together rather than as scattered fixes.

## What Changes

**Correctness / security fixes**

- Background subagents and background shell tasks keep working after the main agent turn ends: the agent session stays connected to funny's permission hook until all background tasks finish (already implemented in `sdk-claude.ts`, uncommitted).
- Every project-scoped route (runtime GitHub routes, server project/settings/designs routes) authorizes the caller through one shared project-access rule; GitHub routes no longer resolve a project by id without an access check.
- Thread working-directory resolution handles scratch threads in every route (`requireThreadCwd` currently fails for them).
- Postgres epoch-millisecond columns are returned as numbers, not strings.
- `projects.closed` is present in both dialect schemas; a schema-drift test guards future divergence.
- Verify whether `startScheduler` (runtime automation scheduler) is intentionally unused; wire it or delete it.

**Dead code removal (no behavior change)**

- Packages: `memory`, `harness`, `design-client` (docs moved to `docs/`), `reviewbot` (byte-identical copy of `agent`'s reviewer).
- `core/src/containers/`, dead GitHub helpers in `core/src/git/github.ts` / `remote.ts`.
- `runtime/src/db/`, `runtime/src/lib/auth.ts` local-DB path, PTY DB persistence, `pty-backend-tmux.ts` and unreachable PTY backends, `transcribe-stream.ts`, ~25 zero-reference exports.
- Client: `components/kanban/` duplicate, ~25 unimported components/hooks, the dead OpenCode model store/hook, legacy `stores/app-store.ts` facade.
- Postgres schema reduced to what is actually used, `shared/src/db/columns.ts`, unused protocol types; `shared/src/evflow.model.ts` moved out of `@funny/shared`.

**Pattern-based simplification (no behavior change)**

- Typed handler registries replace the 62-case `data:*` switch (server, co-located with its scope rule) and the ~75-case client WS event switch.
- Table-driven runner service proxy replaces 56 hand-written forwarders.
- `BaseAgentProcess` helpers for tool_use/tool_result/Think emission; manifest-driven ACP provider classes.
- `core/git` helpers (`gh()`, `nativeOr()`) unify process-error mapping.
- Single schema definition generating both SQLite and Postgres tables; one lazily-built server repository registry.
- Shared helpers/hooks: `resultToResponse` in shared, GitHub project context, thread cwd, sub-agent runner, `useExpandedDiffState`, `usePaginatedGitLog`, `useProjectCrudList`, one markdown engine (drop `react-markdown`), one `computeUnifiedDiff`.

## Capabilities

### New Capabilities

- `project-access-control`: every project-scoped route authorizes through one shared rule with consistent owner/member/org semantics and a non-revealing failure response.
- `agent-background-task-lifetime`: background tasks spawned by an agent keep tool permissions and in-process tool servers until they finish, and the agent process still exits once all work is done.
- `persistence-schema-consistency`: both database dialects expose the same tables/columns with the same JS value types, enforced by a drift check.

### Modified Capabilities

<!-- None: thread-access-control already mandates shared middleware for threads; this change applies the same rule to projects as a new capability. -->

## Impact

- **Packages removed:** `memory`, `harness`, `design-client`, `reviewbot` (root workspace list, CI, and docs references updated).
- **Code:** `packages/core` (agents, git, containers), `packages/runtime` (db, lib/auth, pty, routes/github, services/runner-service-provider, git-pipelines, thread-service), `packages/server` (services/data-handler, data-scope, routes, db), `packages/shared` (db schemas, repositories, runner-protocol), `packages/client` (stores, ws dispatch, diff/markdown/settings components).
- **Dependencies:** `react-markdown` removed from client; `@funny/evflow` removed from `@funny/shared`.
- **APIs:** project routes may now return `404` where they previously returned data for a project the caller cannot access. No other external API changes.
- **Ops:** none — no DB migration beyond the existing columns; runner/server deploy together as usual.
