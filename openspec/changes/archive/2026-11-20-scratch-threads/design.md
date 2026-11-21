## Context

Threads in funny today are anchored to a Project. The user wants a lightweight thread to "bounce ideas" without registering a repo: same chat/tool-call behavior, no project, no git. We call it a **scratch thread**.

### What's actually in the codebase today

(Verified during the design pass — corrects assumptions from the proposal.)

- **`Thread` type** (`packages/shared/src/types/thread.ts`): 40+ fields including templates, automations, designs, container/runtime, parent threads, externalRequestId, etc. `projectId: string` is required at the type level.
- **`threads` table** (defined in `packages/server/src/db/migrate.ts:162-198`, extended through migration 023): `project_id TEXT REFERENCES projects(id) ON DELETE CASCADE` — **already nullable at the SQL level**. The non-nullable constraint lives only in the TypeScript type, not the DB.
- **Thread creation flow** (client):
  1. User clicks something that calls `useUIStore.startNewThread(projectId)` (sets `newThreadProjectId`).
  2. `ThreadView` notices `newThreadProjectId` is set and renders `packages/client/src/components/thread/NewThreadInput.tsx`.
  3. Form submit calls `handleCreate()` (NewThreadInput line 151–259) which posts to the server.
  - There is **no `NewThreadDialog`** — the proposal/spec referenced it generically; the real surface is `NewThreadInput` mounted inline in `ThreadView`.
- **API**: `POST /api/threads` in `packages/server/src/routes/threads.ts:638-642` → proxied to runner at `packages/runtime/src/routes/threads.ts:112-133`. Body schema validated in `packages/runtime/src/validation/schemas.ts` (`createThreadSchema`).
- **cwd resolution** (runtime): **`packages/runtime/src/services/agent-lifecycle.ts`** (not `agent-runner.ts`). Line 193 sets `mcpProjectPath = project?.path ?? cwd`. Line 387 passes `cwd` into `orchestrator.startAgent(...)`. The agent-runner file name from the original design was wrong.
- **Thread delete** (runtime): `packages/runtime/src/services/thread-service/update.ts:305-360`. Worktree cleanup is at lines 325–343 — natural place to add scratch-dir cleanup.
- **Git routes**: `packages/runtime/src/routes/git.ts` is the hub, with subroutes in `routes/git/*.ts`. They use `c.req.query('projectId')` (sometimes `c.req.param('threadId')`) — **not a uniform `:threadId` path**. So the guard goes on the hub via `gitRoutes.use('*', ...)`.
- **Thread list queries**: `packages/shared/src/repositories/thread-repository.ts:102-150` — `listThreads({ projectId, userId, ... })`. Filter builder.
- **Ownership/access**: thread routes already 404 (not 403) on cross-user access (`packages/server/src/routes/threads.ts:242,434,480,...`). No change required to satisfy the spec scenario "user B → user A's thread = 404".
- **Sidebar**: top-level sections live in `Sidebar.tsx`: `SidebarThreadsSection` + `SidebarProjectsSection`. A new `SidebarScratchSection` slots above `SidebarProjectsSection`. The pattern is established.
- **State**: `ui-store.ts` owns the "compose a new thread" intent via `newThreadProjectId`. `thread-store.ts` owns `threadsByProject: Record<projectId, Thread[]>`. We'll add a parallel `scratchThreads: Thread[]` (or use the sentinel key `__scratch__` in `threadsByProject` — see D5).

### The trap

A single `if (thread.isScratch)` check sprinkled across N call sites. The design encapsulates the variation behind two helpers and one new ui-store action, then has callers consume those.

## Goals / Non-Goals

**Goals:**

- Let a user start a thread with one click, no project required.
- Per-user isolation (each user only sees and runs their own scratch threads — same trust boundary as today's per-user runners).
- Reuse the existing message/tool-call/WebSocket pipeline unchanged.
- Concentrate scratch-vs-normal divergence behind a small, named API surface (helpers + a ui-store action), not regex-grep-able conditionals.
- Migration is purely additive: add `is_scratch` column, default 0. `project_id` is already nullable.

**Non-Goals:**

- Per-project "+ New scratch" entry point (v2 if asked for).
- Auto-cleanup by age, quota enforcement, or storage limits.
- "Promote scratch → project" workflow.
- Team-shared scratch threads.
- Git inside the scratch dir (no `git init`, no diff/commit/PR).
- Worktree support for scratch threads.
- Containers/remote runtime support for scratch threads in v1 (they run on the user's connected runner like normal local threads).
- Templates, automations, parent-thread/fork-from semantics for scratch threads in v1 (allowed at the type level but no UI affordances; we'll revisit).

## Decisions

### D1. Reuse `Thread` with a flag, not a new entity

**Choice**: Add `isScratch?: boolean` (optional at the TS type level — DB column is NOT NULL with default 0, so the runtime always has a value, but optionality avoids breaking every existing fixture/factory in storybook stories and ad-hoc thread builders). Keep `projectId: string` (sentinel = `''` for scratch threads at the TS layer; nullable at the DB layer for forward-compat / per-project scratch in v2).

**Why**: A scratch thread shares ~95% of its lifecycle (messages, tool calls, WS, persistence, runner). A parallel entity would duplicate all of that and double every list/query.

**Implementation notes (added during apply)**:

- Making `isScratch` a required `boolean` would have flagged ~10+ storybook story files that construct `Thread` objects without specifying it. Optional + the `canDoGitOps(thread)` helper (which treats `undefined` as not scratch) is the cleaner compromise: callers must still go through the helper, but Thread fixtures don't need a sweeping update.
- The original design called for `projectId: string | null` so the TS compiler would surface every site that assumes a project (~5–15 expected). The actual audit found ~45+ cascade sites (KanbanView, ThreadList, RecentThreads, AllThreadsView, …): many use `threadsByProject[t.projectId]` as an index lookup, which doesn't accept null. To keep the diff bounded and the build green, the TS type stays `string` and scratch threads carry `projectId: ''` at the TS boundary. The DB column remains nullable (no constraint change), and the runtime/server layers treat the scratch flag — not projectId — as the source of truth. Future audit work can incrementally tighten the type to `string | null` per call site without blocking this change. The original justification (compile-time audit of `thread.projectId!`) is partially preserved via the `canDoGitOps(thread)` helper and the empty-string sentinel — code that branches on `if (thread.projectId)` correctly treats scratch threads as projectless.

**Alternative considered**: Auto-create a hidden "Scratch" project per user. Simpler schema, but leaks `isScratch` semantics into `Project` (must filter from every project listing, count, metric). Worse smell.

**Alternative considered**: Derive `isScratch` from `projectId == null` (no new column). Simpler schema. Rejected because it forecloses the v2 "per-project scratch" idea (where `projectId` is set but the thread is still scratch). Cheap to keep the flag explicit.

### D2. cwd lives on the **runner**, namespaced by user and thread

**Choice**: `<userHome>/.funny/scratch/<userId>/<threadId>/`, created lazily on first agent start, removed on thread delete. Path is **derived** (not persisted) — deterministic from `userId` + `threadId` + runner's `os.homedir()`.

**Why**: Agents execute on the runner; cwd must exist there. `<userId>` segment mirrors the per-user trust boundary in `CLAUDE.md → Runner Isolation`. `<threadId>` segment keeps scratch threads from polluting each other. Deriving the path (not persisting `scratchBasePath`) avoids a tiny migration question and keeps the threads row leaner.

**Alternative considered**: persist `scratch_base_path` in the row. Useful if we ever want to honor a custom path. Not needed in v1; trivial to add later.

### D3. One module, two helpers, plus one ui-store action

**Choice**: Add `packages/runtime/src/services/thread-context.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Thread } from '@funny/shared/types';
import { ok, err, type Result } from 'neverthrow';

export type ThreadContextError = { kind: 'project-required' } | { kind: 'worktree-missing' };

export function resolveThreadCwd(
  thread: Pick<Thread, 'isScratch' | 'userId' | 'id' | 'mode' | 'worktreePath'>,
  project: { path: string } | null,
): Result<string, ThreadContextError> {
  if (thread.isScratch) {
    return ok(join(homedir(), '.funny', 'scratch', thread.userId, thread.id));
  }
  if (!project) return err({ kind: 'project-required' });
  if (thread.mode === 'worktree') {
    if (!thread.worktreePath) return err({ kind: 'worktree-missing' });
    return ok(thread.worktreePath);
  }
  return ok(project.path);
}

export function canDoGitOps(thread: Pick<Thread, 'isScratch'>): boolean {
  return !thread.isScratch;
}
```

Plus a client mirror at `packages/client/src/lib/thread-context.ts` exporting only `canDoGitOps(thread)` so `ThreadView` and friends call it.

Plus a ui-store action:

```ts
// ui-store.ts
startNewScratchThread(): void;  // sets newThreadProjectId = null + newThreadIsScratch = true
```

**Why**: The proposal calls this out explicitly. One file owns the divergence rule. Callers stay scratch-agnostic.

### D4. Force `mode: 'local'` for scratch — at the API layer

**Choice**: Server rejects creating a scratch thread with any `mode ≠ 'local'` and with any non-null `projectId`. Enforce in:

- `packages/server/src/routes/threads.ts` POST handler (before proxying).
- `packages/runtime/src/validation/schemas.ts` `createThreadSchema` (defense in depth).

**Why**: Worktree mode needs a git repo. We enforce at the API boundary so the invariant is provable, not "the UI happens not to render the toggle."

### D5. Sidebar gets a top-level "Scratch" section

**Choice**: New component `packages/client/src/components/sidebar/SidebarScratchSection.tsx`, rendered in `Sidebar.tsx` between `SidebarThreadsSection` and `SidebarProjectsSection`. Mirrors the existing section pattern.

State: `thread-store.ts` gains a parallel `scratchThreads: Thread[]` array + actions `loadScratchThreads()`, `addScratchThread(thread)`. We do NOT pollute `threadsByProject` with a sentinel key, because most consumers of that record iterate it; a special key would force every consumer to filter the sentinel.

Per-project listings already filter by `projectId` (non-null), so they naturally exclude scratch — but we still pass `excludeScratch: true` in the repo filter to make the contract explicit.

### D6. Hiding git UI in `ThreadView`

**Choice**: One gate at the parent: `if (!canDoGitOps(thread)) → don't mount ReviewPane, hide commit/push/PR buttons`. Children stay scratch-unaware.

### D7. Cleanup policy: delete-only

**Choice**: Scratch directory is `rm -rf`'d only when the user deletes the thread (added to `thread-service/update.ts` between the worktree-cleanup block and the DB delete). Tolerate missing directory. Log via `log` with `namespace: 'scratch-threads'` per `packages/server/CLAUDE.md`.

**Why**: Simplest correct policy. Auto-cleanup-by-age is a future feature.

### D8. Migration: single additive column

**Choice**: One migration step:

```ts
await ctx().addColumn('threads', 'is_scratch', 'INTEGER NOT NULL', '0');
```

That's it. `project_id` is already nullable at the SQL level (FK `ON DELETE CASCADE`, no `NOT NULL`). No table rebuild.

### D9. WS / message pipeline

**Choice**: Untouched. The broker already keys on `threadId` + `userId` and is agnostic to whether the thread has a project. Verify with a smoke test, then move on.

### D10. Git route guard

**Choice**: Add a `gitRoutes.use('*', ...)` middleware in `packages/runtime/src/routes/git.ts` that:

1. Reads `threadId` from query/param (whichever the sub-route uses).
2. If present and the thread `isScratch`, returns 400 with error code `git-not-allowed-for-scratch`.
3. Otherwise calls `next()`.

**Why**: One middleware vs. patching N sub-routes. The sub-routes already validate `projectId`, so scratch-threads-without-projectId already produce `400 projectId required` — but with a misleading error. The middleware gives a clear error.

### D11. Templates / automations / containers for scratch

**Choice**: Allowed at the type level, **not surfaced in the v1 scratch UI**. The scratch variant of `NewThreadInput` renders only: prompt, model, permission mode. No template selector, no agent template variables, no parent-thread fork, no remote runtime toggle.

**Why**: Keep the v1 surface minimal. The runtime can handle these on a scratch thread — we just don't expose them in the simplified compose UI.

## Risks / Trade-offs

- **[Risk]** A scratch thread agent fills the runner disk with generated files. → **Mitigation (v1)**: none; document the path. **v2**: quota or age-based cleanup.
- **[Risk]** `<userHome>` on the runner isn't writable / `.funny/scratch/<userId>/` collides across runs of the same user on a shared host. → **Mitigation**: same trust assumption as the runner already uses for `~/.funny/auth-secret`, `~/.funny/data.db`, `~/.funny/encryption.key`. No regression.
- **[Risk]** Migration runs but DB had a `NOT NULL` constraint from a previous schema cut. → **Mitigation**: I verified the migration source — `project_id` was created `REFERENCES projects(id) ON DELETE CASCADE` without `NOT NULL`. If a deployment has manually altered it, the migration step `addColumn is_scratch` still succeeds; existing rows pass with default 0.
- **[Risk]** A future contributor calls `thread.projectId!` (non-null assertion) and crashes on a scratch thread. → **Mitigation**: change the TS type to `string | null` so the compiler catches every existing site. Audit during the type change is the safety net.
- **[Risk]** Git route middleware loads the thread on every git request — perf cost. → **Mitigation**: thread fetch is already done in most sub-routes; we can short-circuit if the request has no `threadId`. If perf bites, cache or check `projectId` first.
- **[Trade-off]** No per-project scratch in v1. Acceptable; revisit on demand.
- **[Trade-off]** `NewThreadInput` gains a "scratch mode" branch. Adds branching in one component instead of two components. Worth it because the form fields are 80% the same.

## Migration Plan

1. Add migration step (next number after current latest): `addColumn('threads', 'is_scratch', 'INTEGER NOT NULL', '0')`.
2. Update `Thread` type: `projectId: string | null`; add `isScratch: boolean`.
3. Land server + runtime + client together. No feature flag — additive UI.

**Rollback**: column is additive and ignored by older code. If we have to revert the client, scratch rows remain orphaned but harmless: they don't render anywhere and `/api/git/*` correctly errors on them.

## Open Questions

- **Permission mode default for scratch threads?** _Proposed: same as the user's last-used permission mode, falling back to `default`. If unclear, ask before implementing._
- **Model default for scratch threads?** _Proposed: same as the user's last-used model, falling back to `sonnet`._
- **`createdBy` value?** _Proposed: `userId` (same as a manually created project thread). No need for a special source._
- **Should the scratch directory be one shared dir per user (`~/.funny/scratch/<userId>/`) rather than per-thread?** _Rejected for v1: per-thread keeps deletes simple and isolates threads from each other._

## Realistic LOC Estimate (revised)

```
Schema/migration + types:                ~30 LOC
thread-context.ts (server) + tests:      ~60 LOC
Refactor agent-lifecycle.ts to helper:   ~10 LOC
Scratch-dir create on agent start:       ~15 LOC
Scratch-dir cleanup on delete:           ~15 LOC
Server route validation (POST):          ~25 LOC
Runtime validation schema:               ~10 LOC
Git middleware guard + test:             ~40 LOC
Repo filter (excludeScratch):            ~10 LOC
List-scratch endpoint:                   ~30 LOC
Client API client (createScratch +       ~30 LOC
  listScratch):
ui-store: startNewScratchThread:         ~15 LOC
thread-store: scratchThreads slice:      ~40 LOC
SidebarScratchSection + ThreadList wire: ~120 LOC
NewThreadInput scratch branch:           ~80 LOC
ThreadView git-UI gate + helper:         ~30 LOC
Playwright E2E:                          ~80 LOC
Docs (CLAUDE.md):                        ~20 LOC
─────────────────────────────────────────────────
Total estimate:                          ~660 LOC
```

Bigger than the proposal's 200 LOC guess — the proposal under-counted UI plumbing. Still bounded and worth doing in one change.
