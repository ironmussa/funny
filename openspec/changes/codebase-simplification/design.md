# Design

## Context

See proposal.md for motivation. Findings come from a read-only audit; every deletion candidate was checked for importers with grep (tests excluded), package.json dependencies, root scripts, and CI workflows. Constraints that shape the approach:

- **Runner isolation** (CLAUDE.md): the runtime has no DB and reaches persistence only through `RuntimeServiceProvider`; any access rule it enforces must be computed by the server or carried in the signed forwarded identity.
- **neverthrow mandate**: `packages/core/**` and service boundaries return `Result`; new helpers must keep that shape.
- **Dev-loop hazard**: editing `packages/core` / `packages/runtime` restarts the local dev runner, which kills any in-flight agent session running on it. Implementation of those groups should run from a worktree or a runner that is not watching this checkout.
- `server/src/db/migrate.ts` is an append-only migration history and is out of scope for collapsing.

## Goals / Non-Goals

**Goals:**

- Land the correctness/security fixes first, each with a regression test that fails without the fix.
- Delete unreachable code in small, independently revertible commits.
- Replace each duplicated "list of cases" with one typed source of truth so the duplicates cannot drift again.

**Non-Goals:**

- No change to migration history, wire protocols (gRPC/proto), or public HTTP route shapes beyond the new 404s.
- No generic CRUD base repository — server repositories are thin and domain-specific; only the shared `RepoDeps` type is unified.
- No splitting of large files purely for structure (e.g. `CommitGraphTab.tsx`) unless it removes duplication.
- Batching/ordering logic for `agent:status`, `agent:result`, `agent:tool_call` WS events stays explicit; permanent metrics/spans in client WS dispatch are preserved.

## Decisions

### D1. Background task lifetime: keep the SDK input channel open, close on observed completion

The Agent SDK closes the CLI's stdin when the prompt input ends (and immediately after the first `result` for string prompts), which disconnects funny's PreToolUse hook and in-process MCP servers; later tool calls fall back to the CLI's own prompt and are auto-denied. All queries now use the persistent input channel. Non-steerable sessions close it when (a) a `result` arrives with no non-ambient background task pending — tracked from `task_started` / `task_updated` / `task_notification` — or (b) the CLI emits `session_state_changed: idle` (enabled via `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`).

- _Alternative:_ force subagents to run in the foreground — rejected, it removes a real capability.
- _Alternative:_ rely only on the `idle` event — rejected as sole signal because it depends on a CLI env flag; task tracking is self-contained and `idle` is the backstop.

### D2. One project-access rule, enforced as middleware on both sides

Server: a `requireProjectAccess(level)` middleware (mirroring `middleware/thread-access.ts`) backed by the existing `authorizer.authorize(userId, 'project', id, level)`; it replaces the four inline variants (`settings.ts`, `designs.ts`, `projects.ts` ×2, `project-runner-settings.ts`). Runtime: GitHub, tests, text-search, and browse routes use the existing `requireProject` path (which resolves through the server and checks access), and `resolveGithubProjectContext` takes an already-authorized project instead of an id; it gains `{ optionalToken }` so public-repo routes keep working without a token.

- _Alternative:_ trust the per-user runner boundary — rejected: a runner can host organization/shared projects, and the rule must not depend on deployment topology.
- _Decision (implemented):_ the rule lives in the authorizer's `effectiveProjectRole`: owner → `owner`; collaborator → its `project_members` role (still authoritative for reads until the grants cutover); member of an org the project is shared with (`team_projects`) → `viewer`. Threads stay explicit-only. Mutations (PATCH, members, startup commands) require `manage`; DELETE and runner settings stay owner-only, so org members lose the edit access the old PATCH check gave them.
- _Alternative:_ owner + explicit grant only (the authorizer's previous comment) — rejected: it would revoke the access collaborators and org members rely on today and requires a data migration.

### D3. Typed registries for the two big dispatch switches

- Server `data:*`: `const handlers = { 'data:x': { scope: <rule>, run: (payload, ctx) => … } }`. The dispatcher derives `${type}_response`, and `DATA_SCOPE_RULES` is derived from the same table, so a type cannot exist without a scope rule (keeps the `project-runner-binding` invariant: unknown types refused). `grpc/operations-handler.ts` reads the same table.
- Client WS: `registry: { [K in EventType]: handler }` built with small `lazy(import, fn)` / `transition(fn)` helpers; `ALL_EVENT_TYPES = Object.keys(registry)`; buffered replay uses the registry instead of its own switch.
- _Alternative:_ code generation from proto — rejected, the `data:*` channel is JSON and not proto-described.

### D4. Single schema definition, two dialect builds

`defineTables(b)` in `@funny/shared/db` receives a builder `{ table, text, int, epochMs, bool, isoDate, index, uniqueIndex }`; `schema.sqlite.ts` and `schema.pg.ts` become `defineTables(sqliteBuilder)` / `defineTables(pgBuilder)`. `epochMs` maps to `integer` / `bigint({ mode: 'number' })`; `bool` maps to `integer` / `boolean`. The pg adapter registers an int8 type parser so raw/bigint values return as numbers. A drift test compares both definitions and freshly migrated databases (`PRAGMA table_info` / `information_schema.columns`).

- _Alternative:_ shrink `schema.pg.ts` to the 7 Better Auth tables — simpler, but leaves the trap that importing the pg schema yields wrong shapes; the single definition removes the trap and still deletes ~850 lines.

### D5. Table-driven runner service proxy

`runner-service-provider.ts` holds the three remote client singletons (lazy getters retained if the dynamic imports exist to break an import cycle) and forwards via a typed `forward(client, keys)` helper; the `.bind()` re-export blocks used only by the provider are removed; no-op repositories are produced by one `noopRepo(defaults)`.

### D6. Small shared helpers instead of copies

`BaseAgentProcess.emitToolUse/emitToolResult/emitToolPair/emitThink`; manifest-driven ACP classes via `makeExternalProcessClass`; `core/git` `gh()` + `nativeOr()` with a single error mapper (`toDomainError`); `resultToResponse` moved to `@funny/shared`; runtime `ensureThreadCwd` (uses `resolveThreadCwd`, fixing scratch threads), `runSubAgent`, `persistAndAnnounce`; client `useExpandedDiffState`, `usePaginatedGitLog`, `useProjectCrudList`, one `computeUnifiedDiff`, `parseDiffSide`, Satteri as the only markdown renderer.

### D7. Deletion protocol

Each deletion is its own commit: grep importers across `packages/` (including tests and stories), package.json deps, root scripts, `.github/workflows`, docs; remove; run `bun scripts/fitness/check-typecheck.ts` and the affected package tests. Removed packages are recoverable from git history; no archive copies.

## Risks / Trade-offs

- [Session never ends if a background task's completion event is missed] → `idle` event backstop; `kill()` always closes the channel; regression tests cover task bookkeeping.
- [New 404s break a client flow that relied on lax access] → read level includes owner, member, and org, matching the most permissive existing variant; E2E run of project settings/designs/GitHub panels before merge.
- [Registry refactors change WS event ordering] → batching paths stay explicit; existing ws-event-dispatch tests must pass unchanged; add a test that every `EventType` has a handler.
- [Deleting "unused" code that is loaded dynamically (e.g. `VisualParityFixtureHost`, string-based imports)] → grep for the file stem and testids, not only import statements; check `index.html` / Playwright harness entry points.
- [Large blast radius] → work lands in the task-group order below, one PR per group, each green on typecheck + tests.

## Migration Plan

No data migration. `projects.closed` already exists on Postgres via migration `047`; only the Drizzle definition changes. Deploy server and runner together (Railway) after the D2 and D3 groups because both touch the server↔runner contract internally. Rollback = revert the group's PR.

## Open Questions

- Is `startScheduler` (runtime `automation-scheduler.ts:331`) deliberately unused because scheduling moved to `packages/scheduler`? The task wires it or deletes it accordingly; either way the outcome is observable in an automation test.
