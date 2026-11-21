## 1. Schema, types, and migration

- [x] 1.1 Find the highest-numbered migration step in `packages/server/src/db/migrate.ts` and add a new one that calls `await ctx().addColumn('threads', 'is_scratch', 'INTEGER NOT NULL', '0')`. No constraint change to `project_id` is needed — verify it's already nullable in the table definition (`migrate.ts:162-198`).
- [x] 1.2 Update the Drizzle schema (`packages/shared/src/db/schema-sqlite.ts`, or whichever file the server re-exports from `packages/server/src/db/schema.ts`) to add `isScratch: integer('is_scratch', { mode: 'boolean' }).notNull().default(false)` (or the project's equivalent boolean idiom).
- [x] 1.3 In `packages/shared/src/types/thread.ts`: change `projectId: string` to `projectId: string | null`. Add `isScratch: boolean`. Run `bunx tsc --noEmit` and fix every compile error this surfaces (this is the audit — likely 5–15 sites needing `if (thread.projectId)` guards or non-null assertions removed).
- [x] 1.4 Run `bun run db:push` against a clean DB and against a DB containing pre-existing threads. Confirm `is_scratch` is `0` everywhere and existing threads load fine in the UI.

## 2. Thread-context helpers (server/runtime)

- [x] 2.1 Create `packages/runtime/src/services/thread-context.ts` exporting `resolveThreadCwd(thread, project): Result<string, ThreadContextError>` and `canDoGitOps(thread): boolean`. Use the existing neverthrow + `DomainError` style (see `packages/core/src/git/path-validation.ts` for reference).
- [x] 2.2 Add unit tests in `packages/runtime/test/services/thread-context.test.ts` (or wherever runtime tests live) covering: scratch path resolution, normal local path, worktree path, `project-required` error, `worktree-missing` error.

## 3. Wire helpers into runtime

- [x] 3.1 In `packages/runtime/src/services/agent-lifecycle.ts`, replace the current cwd computation (around line 387 where `cwd` is passed into `orchestrator.startAgent`) with `resolveThreadCwd(thread, project).match(...)`. Map errors to thread status `error` with a useful message.
- [x] 3.2 Update `mcpProjectPath` derivation at `agent-lifecycle.ts:193` so scratch threads don't inherit a stale project path. Use the resolved cwd or skip MCP project context when scratch.
- [x] 3.3 Before spawning the agent for a scratch thread, ensure `<userHome>/.funny/scratch/<userId>/<threadId>/` exists (recursive `mkdirSync`). Log via `log` with `namespace: 'scratch-threads'`.

## 4. Scratch dir cleanup on delete

- [x] 4.1 In `packages/runtime/src/services/thread-service/update.ts` (around lines 305–360 where worktree cleanup runs), add a block after worktree cleanup that, when `thread.isScratch`, calls `rmSync(scratchPath, { recursive: true, force: true })`. Re-derive the path via the helper or replicate the join. Tolerate missing dir.
- [x] 4.2 Log scratch-dir delete via `log` with `namespace: 'scratch-threads'`.

## 5. Server: thread create validation

- [x] 5.1 In `packages/server/src/routes/threads.ts` (POST handler near lines 573–642): accept `isScratch?: boolean` in body. Reject when `isScratch === true && projectId != null` with 400 + error code `scratch-thread-cannot-have-project`. Reject when `isScratch === true && mode && mode !== 'local'` with 400 + error code `scratch-thread-must-be-local`.
- [x] 5.2 When `isScratch` is true, normalize the body to `{ ...body, projectId: null, mode: 'local' }` before proxying to the runner.
- [x] 5.3 In `packages/runtime/src/validation/schemas.ts`, update `createThreadSchema` to accept `projectId: string | null` and `isScratch: boolean` (defense in depth).

## 6. Server/runtime: list scratch threads

- [x] 6.1 In `packages/shared/src/repositories/thread-repository.ts`, extend `listThreads(opts)` to accept `isScratch?: boolean | 'exclude'` and apply the filter: `true` → `is_scratch = 1`, `'exclude'` → `is_scratch = 0`, undefined → no filter.
- [x] 6.2 Update all existing call sites of `listThreads` that scope by project to also pass `isScratch: 'exclude'` so scratch never leaks into project listings.
- [x] 6.3 Add a server route `GET /api/threads/scratch` (or extend an existing list endpoint with a `?isScratch=true` flag — pick whichever fits existing patterns better) that returns the current user's scratch threads.

## 7. Git route guard

- [x] 7.1 In `packages/runtime/src/routes/git.ts`, add `gitRoutes.use('*', async (c, next) => { ... })` middleware that resolves the thread (from `c.req.query('threadId')` or `c.req.param('threadId')`, whichever is present) and returns 400 + `git-not-allowed-for-scratch` when `!canDoGitOps(thread)`. Pass through otherwise.
- [x] 7.2 Add a test that hits a git route with a scratch thread ID and asserts 400.

## 8. Client: API client

- [x] 8.1 In `packages/client/src/lib/api/threads.ts`, add `createScratchThread({ prompt, model, permissionMode })` that POSTs to `/api/threads` with `{ isScratch: true, projectId: null, mode: 'local', ... }`.
- [x] 8.2 Add `listScratchThreads()` matching the server endpoint chosen in 6.3.

## 9. Client: stores

- [x] 9.1 In `packages/client/src/stores/ui-store.ts`, add an action `startNewScratchThread()` and a derived flag `newThreadIsScratch: boolean`. The action sets `newThreadProjectId = null` + `newThreadIsScratch = true`.
- [x] 9.2 In `packages/client/src/stores/thread-store.ts`, add `scratchThreads: Thread[]`, action `loadScratchThreads()`, and a WS-event hook so new scratch threads append correctly. Do NOT use a sentinel key in `threadsByProject`.
- [x] 9.3 Add a client-side `canDoGitOps(thread)` helper in `packages/client/src/lib/thread-context.ts` (mirror of the runtime one).

## 10. Client: NewThreadInput scratch variant

- [x] 10.1 In `packages/client/src/components/thread/NewThreadInput.tsx`, detect `newThreadIsScratch` from `ui-store`. When true: render only prompt, model, permission mode (hide branch picker, mode toggle, runtime selector, template selector, parent-thread context, file references).
- [x] 10.2 In `handleCreate()` (line 151–259), when scratch, call `createScratchThread()` instead of `createThread()`. After success, update `scratchThreads` (not `threadsByProject`) and navigate to the new thread.
- [x] 10.3 Add `data-testid` attributes: `new-thread-scratch-prompt`, `new-thread-scratch-model`, `new-thread-scratch-submit`.

## 11. Client: Sidebar Scratch section

- [x] 11.1 Create `packages/client/src/components/sidebar/SidebarScratchSection.tsx` mirroring `SidebarThreadsSection`. Render the user's scratch threads (from `thread-store.scratchThreads`).
- [x] 11.2 In `packages/client/src/components/Sidebar.tsx`, mount `SidebarScratchSection` between `SidebarThreadsSection` and `SidebarProjectsSection`.
- [x] 11.3 Header "+ New" button with `data-testid="sidebar-scratch-new"` calls `ui-store.startNewScratchThread()`.
- [x] 11.4 Load scratch threads on mount (call `loadScratchThreads()` from the same place projects are loaded).

## 12. Client: ThreadView git-UI gate

- [x] 12.1 In `ThreadView` (or wherever the review pane / commit / push / PR buttons are mounted), gate them on `canDoGitOps(thread)`. When false: no review pane tab, no diff toggle, no git actions.
- [x] 12.2 Verify the existing review pane behavior is unchanged for non-scratch threads (no regression in normal threads).

## 13. Auth boundary regression test

- [x] 13.1 Add a test (server route test, not E2E) that creates a scratch thread as user A, then requests it as user B by ID, and asserts 404. The pattern likely already returns 404 via the existing ownership check at `packages/server/src/routes/threads.ts:242` — confirm with a test.

## 14. End-to-end

- [x] 14.1 Add a Playwright E2E test: sign in → click sidebar "Scratch" "+ New" → enter prompt → submit → assert thread appears in Scratch section, agent message streams in, no review pane is rendered.
- [x] 14.2 Run `bun run build` to ensure all packages still build. _(Runtime + server packages build cleanly. The client build was already failing on master with the same pre-existing TS errors; per-package `bunx tsc --noEmit` confirms this change introduces zero net new errors in `packages/runtime`, `packages/server`, or `packages/client`.)_
- [x] 14.3 Run `bunx tsc --noEmit` to type-check the whole project. _(Per-package check shows 0 net new errors; the existing master-branch errors are unrelated to this change.)_

## 15. Documentation

- [x] 15.1 In root `CLAUDE.md`, add a "Scratch threads" subsection under "Architecture" with: the path convention `<userHome>/.funny/scratch/<userId>/<threadId>/`, the lifecycle, and the no-git rule.
- [x] 15.2 Optional: mention in `INSTALL.md` "Machine B — Runner" trust-boundary section that scratch dirs live in the runner's `~/.funny/scratch/`.
