# Design

## Context

See proposal.md for motivation; requirements are in `specs/client-entity-sync/spec.md`.

Current state of the client data layer (`packages/client/src/`):

- **Threads.** The canonical rows live in `useThreadStore.threadsById`. Bucket order is kept in `threadIdsByProject`, `scratchThreadIds` and `sharedThreadIds`, totals in `threadTotalByProject` / `scratchThreadTotal` / `sharedThreadTotal`. Every write goes through `stores/thread-mutations.ts`.
  - Project lists use offset pagination (`api.listThreads(pid, includeArchived, 50)`, `loadMoreThreads` with `offset = ids.length`), sorted on the server by `pinned DESC, COALESCE(completedAt, createdAt) DESC`. Scratch lists load a fixed 100; shared lists have no limit.
  - `replaceProjectThreads` keeps archived IDs that a non-archived reload omits.
  - Incoming rows go through `reconcileIncomingThread` (a local terminal status beats an older active row) and then `reconcileBoardWrite` (the 5 s guard in `thread-optimistic-guard.ts`).
- **Thread detail.** `threadDataById` (`ThreadWithMessages`) holds a full copy of the row plus the messages/tool-call workspace. `activeThread` mirrors the selected entry and `patchThread` copies row changes into it. Fetching goes through the xstate `threadDataMachine` in `thread-machine-bridge.ts`, and status transitions go through `threadMachine`.
- **Readers.**
  - `lib/thread-selectors.ts` (`useThreadById`, `useThreadsForProject`, `useScratchThreads`, `useSharedThreads`, `useThreadsByProject`) memoizes over the ID arrays.
  - Kanban and AllThreads (`AllThreadsView.tsx` → `KanbanView.tsx`, `groupThreadsByStage`) filter and sort in components. So does the sidebar Activity list (`sidebar/ThreadList.tsx`).
- **Realtime.** `hooks/use-ws.ts` → `hooks/ws-event-dispatch.ts` (`WEB_EVENT_HANDLERS`, with an rAF batch for streaming) → `stores/thread-ws-handlers.ts`. Sidebar-visible thread fields go through `patchSidebarThread` → `patchThread`. Events for threads that are not loaded trigger a debounced project refresh.
- **Other entity stores.**
  - With bespoke freshness/WS handling: project, agent-template, automation, comment, job, watcher, scheduler, pipeline-approval (raw `fetch`), pr-detail, git-status (custom cooldown maps plus aborts), branch-picker, acp-models.
  - Using `stale-fetch.ts`: runner-providers and sandbox-connections only.
- **API client.** `lib/api/_core.ts` `request<T>()` returns neverthrow `ResultAsync<T, DomainError>` and accepts an `AbortSignal`.
- **Tests.** Vitest 4 + jsdom. API modules are mocked with `vi.mock` returning `okAsync`/`errAsync`.
- **Library.** `@tanstack/db@1.0.0-rc.1.2`, `@tanstack/react-db@1.0.0-rc.1.2`, `@tanstack/query-db-collection@1.5.1` (peer `@tanstack/query-core ^5.90`). The core is framework- and DOM-agnostic. It provides:
  - `createCollection` with a custom `sync` (`begin`/`write`/`commit`/`markReady`)
  - `queryCollectionOptions`, whose utils include `writeInsert/Update/Upsert/Delete/Batch` for direct synced writes
  - `onInsert/onUpdate/onDelete` mutation handlers with automatic rollback when the handler throws
  - `createOptimisticAction`
  - `useLiveQuery` / `createLiveQueryCollection` with incremental maintenance

Constraints: `client-platform-services` (renderer-independent state must not touch DOM/browser globals), neverthrow at service boundaries, Effect preferred for new async orchestration (AGENTS.md), shadcn-only UI (unaffected), `data-testid` rules (unaffected).

## Goals / Non-Goals

**Goals:**

- One TanStack DB collection per server-backed entity is the only place its rows live. Zustand keeps no copy of the rows, apart from a temporary read-only projection during migration.
- Optimistic writes become collection transactions. Stale-response protection is deterministic, with no time window.
- List membership, order and grouping are live queries, not stored arrays.
- Existing hook names and return shapes are kept so components migrate without call-site churn. The hooks are reimplemented, not renamed.
- Every phase can ship independently and leaves the app fully working.

**Non-Goals:**

- Messages, tool calls, thread events and pagination windows (`threadDataById` workspace fields), plus streaming batching. These stay in Zustand, the xstate machines and `ws-event-dispatch.ts`.
- WS-only, event-derived state with no list endpoint: pipeline active runs, workflow-run, presence, runner-status, commit-progress, native-git, terminal, browser panel, test store.
- UI, settings, auth and profile stores.
- Server API, WS protocol and DB changes. Offline persistence (TanStack DB IndexedDB/localStorage collections). Adoption in `client-gpuix`.
- Server-side predicate pushdown (`syncMode: 'on-demand'`). Pagination stays explicit (see D3).

## Decisions

### D1. Data layer lives in `packages/client/src/data/`, written renderer-independent

Collections, sync adapters and actions go in `packages/client/src/data/<entity>/` (`collection.ts`, `sync.ts`, `actions.ts`, `hooks.ts`). Only `hooks.ts` imports React (`@tanstack/react-db`). The other files import only `@tanstack/db`, `@tanstack/query-core`, `@funny/shared`, `@funny/client-core` and the API modules. `data/**` (excluding `hooks.ts`) is registered as renderer-independent so the existing `client-platform-services` lint guards it.

_Alternative:_ put it in `packages/client-core` now for `client-gpuix` reuse. Rejected for this change: client-core currently has no network-entity state, gpuix adoption is a non-goal, and hoisting a DOM-free module later is a mechanical move.

### D2. One per-session `DataLayer` instance, recreated on auth change

`createDataLayer({ api, queryClient, userId })` builds every collection and returns `{ collections, actions, dispose }`. `data/runtime.ts` holds the current instance, swaps it when `auth-store`'s user changes, and calls `dispose()` (collection `cleanup()` plus `queryClient.clear()`) **before** the new session's first fetch. Hooks read the instance through a `useDataLayer()` subscription, so every view re-subscribes to fresh collections. This satisfies _Per-user data isolation_. Tests construct their own instance with mocked API modules and need no global setup.

_Alternative:_ global module-level collections cleared on logout. Rejected: a fetch still in flight from the old session could write into the shared collection after the clear.

### D3. Threads: custom-sync collection fed by explicit loaders, with a list-meta store

`queryCollectionOptions` treats each `queryFn` result as the complete set and deletes absent rows. That conflicts with threads arriving from many partial sources: paged project lists, archived/non-archived variants, scratch, shared, detail, and WS. So `threads` is a `createCollection` with a custom `sync`, keyed by `id`. The sync function exposes a writer to the loaders (`loadProjectThreads`, `loadMoreProjectThreads`, `loadScratchThreads`, `loadSharedThreads`, `upsertFromDetail`). Each writer applies one batch inside `begin()`/`commit()`.

- **Fetch de-duplication and freshness** use a shared `QueryClient` (`query-core`): each loader calls `queryClient.fetchQuery({ queryKey: ['threads', 'project', pid, { archived }], staleTime })`. This replaces the ad-hoc `pid|archived` in-flight map and `stale-fetch.ts`. `retry: false` keeps today's error behavior. The query `signal` is passed to `request()` so a superseded or disposed fetch is aborted.
- **Replace semantics** are preserved explicitly. A full reload of a source removes only rows that the same source previously contributed and that the new page window should have contained. Archived rows survive a non-archived reload, as today. Source membership is tracked per row in the adapter (`sources: Set<SourceKey>`), not stored on the row.
- **List meta** (totals, loaded/loading/error per source, page offset) lives in a small Zustand store `data/threads/list-meta.ts`. It is not entity data, and keeping it there keeps "not loaded" distinct from "empty" (spec: _Event for an unloaded project_).
- **Merge rules** from `reconcileIncomingThread` move into the adapter's single `mergeIncoming(prev, next, fence)` function.

### D4. Write fencing replaces the 5 s guard

TanStack DB keeps an optimistic change layered over synced state while its transaction is pending. That alone covers _Stale list response during an archive_ while the request is in flight. The remaining hole is a list GET that **started before** the write was confirmed but **resolves after** the handler finished. That response would overwrite the newly confirmed synced row with pre-write values.

Fix: a monotonic per-session sequence `seq`.

- Every loader records `startedSeq` when its request begins.
- Every confirmed mutation records `fence[id][field] = seq` at confirmation.
- `mergeIncoming` drops a fenced field from an incoming row whose `startedSeq < fence[id][field]`. Other fields are still applied, so a concurrent status change still lands.
- Fences are cleared once a response that started after the fence has been merged.

Mutation handlers write the server's response row into synced state (sync writer) **before** returning, so the optimistic layer is never removed before synced state matches (_Confirmed state converges_, no flicker).

This makes the guarantee independent of latency (_Slow confirmation_). Unit tests cover the interleavings.

_Alternative:_ compare `updatedAt`. Rejected as the sole mechanism: not every server path bumps `updatedAt` (runner status updates), and clock-based comparison is what the 5 s guard already approximates. `updatedAt` stays as a tie-break in `mergeIncoming` only where it is strictly newer.

### D5. Mutations: manual pending transactions + named actions, neverthrow at the edge

Thread writes are explicit actions in `data/threads/actions.ts` (`archiveThread`, `unarchiveThread`, `moveThreadStage`, …). Each action:

1. Opens `createTransaction({ autoCommit: false, mutationFn: async () => {} })` and applies the change with `collection.update` inside `tx.mutate()`. The overlay is visible in the same tick.
2. Runs the API step(s) **outside** the transaction. Steps are the existing `ResultAsync` calls.
3. On each successful step, calls `confirmWrite` (fence plus synced write).
4. Finally runs `tx.commit()` on success, or `tx.rollback()` plus a toast on the first `err`.

The public action returns `ResultAsync<void, DomainError>`. Multi-step writes (unarchive = archive + stage) keep the steps that were already confirmed when a later step fails.

_Why not collection `onUpdate` handlers:_ verified against 1.0.0-rc.1.2, while any transaction on a collection is _persisting_, TanStack DB holds back **every** synced write to that collection until it settles. With handlers, a slow archive would freeze realtime status updates for every other thread. A _pending_ manual transaction holds nothing: synced writes to other rows land immediately, and the overlay stays above its own row until commit or rollback. Rollback restores the latest synced row, including realtime changes that arrived meanwhile. The collection defines no handlers, so a bare `collection.update()` outside an action throws instead of silently skipping the server.

_Alternative:_ keep store actions doing manual snapshots. Rejected; manual snapshots are the duplication this change removes.

### D6. Realtime events become synced writes through one adapter entry point

`patchSidebarThread` is already the single choke point for sidebar-visible WS updates. It is reimplemented as `threadsSync.applyEvent(id, patch)`, a synced write (`begin/write(update)/commit`). Several events become sync writes in the threads adapter:

- `thread:created`
- `thread:updated`
- `thread:stage-changed`
- `thread:share-granted` and `thread:share-revoked`
- the row-field parts of `agent:status`, `agent:result` and `agent:message` (status, `lastAssistantMessage` snippet, `completedAt`, comment count)

Rules:

- Updates for keys the collection does not hold are **not** inserted as partial rows. They keep today's debounced project refresh.
- Streaming row-field updates are applied from the existing rAF batch flush, so the number of writes per frame does not grow.
- Thread status still goes through `threadMachine` (`transitionThreadStatus`) first. The collection receives the resulting status. The machine keeps its role.

Workspace parts of these events (messages, tool calls, events) keep flowing to `threadDataById` unchanged.

### D7. Read hooks become live queries with the same signatures

- `useThreadsForProject(pid)`: `useLiveQuery(q => q.from({t: threads}).where(t.projectId = pid, !t.isScratch).orderBy(pinned desc, activityTime desc))`.
- `useScratchThreads()` and `useSharedThreads()`: the same pattern. Shared membership comes from the adapter's source tag, exposed as a virtual field.
- `useThreadById(id)`: `collection.get` via `useLiveQuery` with a key filter.
- `useThreadsByProject()`: one live query grouped in a memo keyed on the live result.

`activityTime` is computed in the query, to match the server's `COALESCE(completedAt, createdAt)`. Kanban's `groupThreadsByStage` and the sidebar Activity list become live queries in `data/threads/views.ts`. Their filter and sort logic moves out of components unchanged, which yields _Derived views stay consistent_.

Row object identity must be stable for unchanged rows so `React.memo` cards do not re-render. A hook test asserts this.

### D8. Migration via a temporary read-only Zustand projection

So phases can ship independently, the collection becomes canonical in phase 2. `threadsById` and the bucket arrays are then **derived** from it by a `subscribeChanges` projection. The projection uses the same ordering as D7, and nothing else may write those fields: `thread-mutations.ts` list helpers delegate to the collection. Unmigrated readers keep working.

Each later phase moves readers to the D7 hooks. The final threads phase deletes the projection, the bucket fields, the list helpers in `thread-mutations.ts`, and `thread-optimistic-guard.ts`.

For the detail view, row fields of `threadDataById[id]` / `activeThread` are populated from the collection by the same projection. This replaces the `patchThread` mirroring. Removing the row-field copy from `ThreadWithMessages` (about 54 `activeThread` references) is the last threads task.

### D9. Simpler entities use `queryCollectionOptions` directly

Entities that come from one complete list endpoint use `queryCollectionOptions`. WS events become `utils.writeUpsert` / `writeDelete`. Where each entity comes from:

- agent templates
- runner providers and sandbox connections (removes `stale-fetch.ts`)
- ACP models per provider
- jobs and watchers, with WS upserts
- automations per project, with inbox and runs as separate collections
- pipeline approvals, which also moves the raw `fetch` onto `request()`
- scheduler runs and comments per thread, with WS upserts and deletes
- projects, with optimistic reorder, rename, update and delete through handlers
- git status, keyed by branch key and fed by `git:status`. The custom cooldown maps are replaced by `staleTime` and the aborts by the query signal.

PR detail and branch lists are request caches with no shared entity identity. They use `QueryClient` queries (`fetchQuery` with `staleTime`), not collections.

> **Phase 6 note.** `queryCollectionOptions` was dropped after a probe: a direct write starts the collection's `queryFn` and a `refetch` removes directly written rows. Entities use `data/entities.ts` (custom sync, synced writer) and `data/optimistic-write.ts` (manual pending transactions) instead, the same contract as the threads collection.

### D10. Effect is not introduced into this layer

Retries are disabled and cancellation comes from query-core's `AbortSignal` plumbed into `request()`. That is the explicit Promise/API boundary AGENTS.md asks for, and there is no orchestration left that Effect would improve. If a later phase needs retry/backoff (for example, reconnect resync), it uses Effect at that call site.

### D11. Guardrails

- A fitness check (`scripts/fitness/check-client-data-layer.ts`, in `bun run lint`) fails on:
  - writes to collections (`.insert(` / `.update(` / `.delete(` on a collection, or sync writer use) outside `src/data/**`
  - new imports of the removed thread-index fields once phase 4 lands
- Components import only from `data/*/hooks.ts` and `data/*/actions.ts`.
- `CLAUDE.md` and openwiki describe the pattern in place of the `threadsById` rules.

## Risks / Trade-offs

- **[RC dependency]** TanStack DB is 1.0 RC; its API may still change. → Pin exact versions. Keep library calls behind `data/**` so an upgrade touches one directory. Re-check release notes at each phase.
- **[Bundle size]** The core, IVM engine and query-core add weight. → Measure `bun run build` output in phase 1 against a budget recorded in tasks. Removed code offsets part of it.
- **[Live query cost with streaming]** Many row-field writes per second during agent runs could recompute views. → Writes are coalesced in the existing rAF batch (D6). A benchmark task measures sidebar/Kanban update cost with 500 threads and 10 running agents before and after. _Measured in phase 3:_ ≈0.6 ms/frame vs ≈0.17 ms/frame legacy (500 threads, 10 streaming agents). Well inside a frame but ≈3–4× the legacy derivation; collection writes + IVM maintenance are the floor.
- **[Order drift vs server]** Client ordering must match the server's `pinned, COALESCE(completedAt, createdAt)` sort, or paging produces gaps or duplicates. → A single shared comparator. Parity test against the repository's sort on fixture data.
- **[Fencing bugs]** Wrong fences either revert writes or block legitimate remote changes. → Fencing is per field, and fences clear after the first post-fence response. Exhaustive interleaving tests (GET-before-write/resolve-after, concurrent WS, failure). Spec scenarios map to tests one-to-one.
- **[Dual state during migration]** The projection could be written by legacy code. → The projection is the only writer of those fields, enforced by the D11 check from phase 2.
- **[Detail/workspace coupling]** `threadDataById` and `activeThread` hold row copies relied on by about 54 references. → Kept in sync by the projection until the final threads task. That task is isolated and can slip without blocking the entity phases.
- **[Session-swap races]** In-flight requests from the previous user. → `dispose()` aborts query signals, and writers check that their `DataLayer` is still current before writing.

## Migration Plan

Phases are ordered so each one lands green (lint, typecheck, unit tests) and can be released on its own:

1. **Foundations.** Pinned deps, `QueryClient`, `DataLayer` factory and session swap, test harness. No behavior change.
2. **Threads collection canonical + Kanban.** Collection, sync adapter, fencing and the read-only projection. Kanban/AllThreads read through live queries. Archive, unarchive and stage moves become transactions. The guard is bypassed for these and then deleted.
3. **Remaining thread writes + WS events.** Rename, pin, permission mode and delete become transactions. Row-field WS events become sync writes.
4. **All thread readers on live queries.** Sidebar, Activity, scratch, shared, pickers, mobile. Delete the projection's bucket fields, `thread-mutations.ts` list helpers and `thread-optimistic-guard.ts`.
5. **Detail row fields.** Remove row copies from `threadDataById` / `activeThread`.
6. **Other entities** (D9), one store per task, deleting each Zustand store as it is replaced, and finally `stale-fetch.ts`.
7. **Docs and guardrail finalization.**

Rollback: each phase is a separate PR. Reverting a phase's PR restores the previous one's state, because the projection keeps the legacy fields valid until phase 4.
