# Proposal

## Why

The client keeps server-backed entities (threads, projects, automations, templates, runners, …) in hand-rolled Zustand structures: a normalized thread index with sibling ID arrays, a mutation-helper module that every write must go through, per-store freshness bookkeeping, ~1.2k lines of WebSocket patch handlers, and a time-based guard (`thread-optimistic-guard.ts`) that hides — but does not eliminate — optimistic writes being reverted by stale list responses. Each of these is an invariant enforced by convention (documented in `CLAUDE.md`), and each new entity or view re-implements part of it. TanStack DB (now at 1.0 RC) provides exactly this layer — keyed client collections, a sync contract fed by fetches and realtime events, optimistic transactions that layer over synced state and roll back on failure, and incrementally-maintained live queries — so we can replace convention with a library guarantee before the hand-rolled layer grows further.

## What Changes

- Introduce a client data layer built on TanStack DB: one collection per server-backed entity, each with a sync adapter that loads via the existing API client and applies realtime (WS) events as synced writes.
- Replace the normalized thread index (`threadsById`, `threadIdsByProject`, `scratchThreadIds`, shared-thread bucket) and `thread-mutations.ts` with a `threads` collection; bucket membership/order become live queries instead of stored arrays.
- Replace the read selectors in `thread-selectors.ts` (`useThreadById`, `useThreadsForProject`, `useScratchThreads`, `useThreadsByProject`) with live-query-backed hooks that keep the same names and return shapes, so components migrate without call-site changes.
- Replace optimistic thread writes (archive/unarchive, stage move, rename, pin, delete, …) with TanStack DB transactions; **remove** `thread-optimistic-guard.ts`.
- Move thread-list WS handling (status, stage, title, archived, git summary, created/deleted) out of `thread-ws-handlers.ts` into the threads collection's sync adapter.
- Migrate the other server-backed entity stores (projects, automations, agent templates, pipelines, runners/provider lists, and other list caches currently using `stale-fetch.ts`) to collections; **remove** `stale-fetch.ts` once its last caller is gone.
- Migrate Kanban first (proof of the pattern), then Activity / AllThreads / Sidebar, then the remaining entity stores.
- Keep Zustand for ephemeral UI state, settings/preferences, terminal, browser panel, drafts, presence, the per-thread message/tool-call workspace (streaming deltas and message pagination), and the thread state machine bridge.
- Update `CLAUDE.md` / openwiki client-architecture guidance to describe the collection pattern and retire the "never touch `threadsById` outside `thread-mutations.ts`" rule.

No server API, WS protocol, or database change. No user-visible feature change beyond the reliability guarantees in the spec.

## Capabilities

### New Capabilities

- `client-entity-sync`: How the client holds server-backed entities — a single canonical record per entity shared by every view, optimistic writes that never visibly revert on stale responses and roll back with feedback on failure, realtime convergence, request de-duplication/freshness, and consistency between list views.

### Modified Capabilities

<!-- None. `client-platform-services` requirements (renderer-independent state, host-mediated transport/effects) still hold and constrain the design, but are not changed. -->

## Impact

- **Code:** `packages/client/src/stores/` (thread-store, thread-mutations, thread-selectors, thread-optimistic-guard, thread-ws-handlers, project-store, automation-store, agent-template-store, pipeline-store, runner-* stores, stale-fetch, store-bridge), `packages/client/src/hooks/use-ws.ts`, Kanban / Activity / AllThreads / Sidebar components and their tests. Possibly `packages/client-core` if collections are placed there for reuse by `client-gpuix` (decided in design).
- **Dependencies:** add `@tanstack/db`, `@tanstack/react-db`, `@tanstack/query-db-collection`, and `@tanstack/query-core` (new transitive runtime). TanStack DB is a 1.0 release candidate; versions will be pinned exactly.
- **Bundle:** adds the DB core + IVM engine + query-core to the client bundle; measured against the code removed.
- **Docs:** `CLAUDE.md` client-architecture and scratch-thread sections, openwiki client architecture page.
- **Risk:** large, cross-cutting client refactor; mitigated by per-surface phases each shippable on its own (see design.md).
