# Plan: Route-Driven Thread Selection (funny-specific)

URL as the single source of truth for which thread is active. This is the
funny-specific adaptation of the generic "route-driven state" plan, mapped onto
the **real** modules, names, and constraints in this codebase.

> Generic terms → funny terms: `entity` → `thread`, `selectedId` → `selectedThreadId`,
> `activeEntity` → `activeThread`, `goToEntity` → `goToThread`, `entityCache` → thread data cache.

---

## 0. Where funny actually is today (not greenfield)

funny is **mid-migration**. It already has a route-driven layer *and* the
reconciliation machinery the generic plan wants to delete — they coexist, which
is exactly what produces the ping-pong.

| Generic concept | funny reality | Status |
|---|---|---|
| `parseRoute` / route boundary | [route-parser.ts](../packages/client/src/hooks/route-parser.ts), [use-route-sync.ts](../packages/client/src/hooks/use-route-sync.ts) | ✅ exists |
| `entitiesById` cache | `threadsById` (unified index in [thread-mutations.ts](../packages/client/src/stores/thread-mutations.ts)) | ✅ clean |
| `goToEntity` single facade | **none** — 3 controllers call `selectThread` | ❌ |
| `selectedId` (pointer) | `selectedThreadId` | ⚠️ keep, but derive |
| `activeEntity` (pointer) | `activeThread` — **NOT a pointer, it's the hydrated payload** | ⚠️ demote to cache |
| Invariant guard (to delete) | [use-route-sync.ts:111-175](../packages/client/src/hooks/use-route-sync.ts#L111-L175) | ❌ the ping-pong |

### The single most important correction to the generic plan

`activeThread` is a `ThreadWithMessages` — it carries `messages`, `threadEvents`,
`compactionEvents`, `initInfo`. `selectThread(id)` is **async**: it sets
`selectedThreadId` synchronously, then hydrates `activeThread` later (with a
`selectGeneration` counter to drop stale loads and `selectingThreadId` for
in-flight dedup — see [thread-store-internals.ts](../packages/client/src/stores/thread-store-internals.ts)).

So the generic "delete `activeEntity`" step does **not** apply literally. The
target is:

- **Keep** the hydrated payload, but store it as a **cache keyed by threadId**
  (`threadDataById[id]` with `loadingById` / `errorById`), not as a single
  mutable `activeThread` pointer.
- **Derive** *which* thread is active from `useParams().threadId`.
- The detail view becomes `useThreadData(useActiveThreadId())` — a cache lookup,
  not a subscription to a moving pointer.

This is the **cache-aside** pattern the generic plan's §12 references — funny just
already has the cache (`threadsById` for rows) and needs a sibling cache for the
heavy per-thread payload.

### Why the guard exists (do not delete it blind)

[use-route-sync.ts:111-175](../packages/client/src/hooks/use-route-sync.ts#L111-L175)
re-selects when `activeThread?.id !== urlThreadId`. Its stated reason: WS handlers
drop messages for a thread that isn't hydrated. **But** WS routing already keys off
**hydration**, not "active": [thread-ws-handlers.ts](../packages/client/src/stores/thread-ws-handlers.ts)
calls `isHydrated(state, threadId)` and buffers (`maybeBuffer`) otherwise; sidebar
snippets update independently via `patchSidebarLastAssistant`. So the guard is
compensating for the fact that **hydration is tied to a single `activeThread`
slot** rather than a per-id cache. Fix the cache shape (Phase 3) and the guard's
reason for existing disappears — then Phase 4 can delete it safely.

---

## 1. Target architecture (funny names)

```
UI (sidebar / shortcuts / links)
  └─ goToThread(navigate, projectId, threadId)        ← only navigates
        │
        ▼
Router  /projects/:projectId/threads/:threadId         ← source of truth
        │  useParams().threadId
        ▼
Route boundary (one effect or RR loader)
  └─ threadData.ensureLoaded(threadId)  (idempotent, in-flight deduped)
        │
        ▼
Thread data cache (Zustand)
  threadDataById, loadingById, errorById, inflight Map
  (NO single `activeThread` pointer; NO `selectedThreadId` writes from UI)
        │
        ▼
Detail view
  const id = useActiveThreadId()        // = useParams().threadId
  const data = useThreadData(id)        // cache lookup
```

### Modules to create

| Module | Responsibility |
|---|---|
| `navigation/thread-paths.ts` | `buildThreadPath(projectId, threadId)`, `buildScratchPath(threadId)` — wrap the existing route shapes from `route-parser.ts` |
| `navigation/go-to-thread.ts` | **Only** thread-change API for UI. Wraps `useStableNavigate`. Handles scratch vs project via `getThreadRoute(thread)` (already in [thread-variant.ts](../packages/client/src/lib/thread-variant.ts)) |
| `hooks/use-active-thread-id.ts` | thin wrapper over `useParams().threadId` |
| `hooks/use-thread-data.ts` | `threadDataById[id]` + loading/error |

### Modules to demote / delete (in order, Phases 3-4)

- `applyThreadRoute` direct `selectThread` call → boundary `ensureLoaded`
- the invariant guard ([use-route-sync.ts:111-175](../packages/client/src/hooks/use-route-sync.ts#L111-L175))
- `selectGeneration` / `selectingThreadId` / `getSelectingThreadId` in
  [thread-store-internals.ts](../packages/client/src/stores/thread-store-internals.ts)
  — replaced by the `inflight` Map keyed by id
- `activeThread` as a single slot → `threadDataById[id]`
- UI writes to `selectedThreadId`

---

## 2. Phases (funny-specific, with real exit criteria)

### Phase 0 — Inventory (½–1 day)

- [ ] Grep call sites of `selectThread`, `clearThreadSelection`, `selectProject`,
      and every `navigate(` in `packages/client/src/components/**`.
- [ ] Confirm the 3 controllers that drive selection:
      `applyThreadRoute` ([use-thread-project-sync.ts:50](../packages/client/src/hooks/use-thread-project-sync.ts#L50)),
      the invariant guard ([use-route-sync.ts:129](../packages/client/src/hooks/use-route-sync.ts#L129)),
      and the sidebar/ThreadList click handler.
- [ ] List every reader of `activeThread` (many — see the deprecated
      `useActive*` hooks in [thread-selectors.ts](../packages/client/src/stores/thread-selectors.ts);
      the migration target `thread-context.tsx` already exists).
- [ ] Confirm WS handlers route on `isHydrated` / `selectedThreadId`, not `activeThread`.

**Manual cases to script as tests (Phase 6):** sidebar A→B, deep link `/threads/B`,
back/forward, refresh on B, rapid A→B→C, WS event for B while URL shows A,
scratch thread `/scratch/:id`, new-thread compose `/scratch/new` then create.

**Exit:** inventory complete; no surprise `selectThread` caller outside the 3.

### Phase 1 — Freeze the navigation API (1–2 days, low risk)

- [ ] `navigation/thread-paths.ts` — `buildThreadPath` / `buildScratchPath`,
      reusing `stripOrgPrefix` semantics so the org-slug prefix is preserved.
- [ ] `navigation/go-to-thread.ts` — single facade. Internally uses
      `getThreadRoute(thread)` from [thread-variant.ts](../packages/client/src/lib/thread-variant.ts)
      so scratch vs project routing stays in one predicate (per CLAUDE.md's
      "single source of truth: named predicates" rule).
- [ ] Migrate sidebar `ThreadItem` / `ThreadList`, keyboard shortcuts, inbox,
      and internal links to `goToThread`. Keep them navigation-only.

**Code review rule:** UI imports `goToThread` or `<Link to={buildThreadPath(...)}>`.
Forbidden: `selectThread()` + `navigate()` in the same UI handler.

**Exit:** 0 UI call sites that select + navigate separately.

### Phase 2 — Route boundary becomes the only hydrator (2–4 days, medium)

Use the **effect-in-layout** option (Option B in the generic plan) — funny is on
React Router but not using data loaders for this, and an effect is the smaller diff.

- [ ] Create the thread data cache store: `threadDataById`, `loadingById`,
      `errorById`, `inflight: Map<string, Promise>`, `ensureLoaded(id)`.
      Move the body of today's async `selectThread` hydration into `ensureLoaded`,
      keyed by id (replaces `selectGeneration`/`selectingThreadId` with the Map).
- [ ] In the existing route effect ([use-thread-project-sync.ts](../packages/client/src/hooks/use-thread-project-sync.ts)),
      replace `applyThreadRoute`'s `ts.selectThread(threadId)` with
      `threadData.ensureLoaded(threadId)`. Keep `selectProject` for now.
- [ ] Error path renders in the boundary (NotFound/Spinner), no silent redirect.
- [ ] Keep `activeThread` written for now (compat) — Phase 3 removes the slot.

**Exit:** one module hydrates from the URL; no other effect calls hydration.

### Phase 3 — Derive selection from the URL (3–5 days, medium)

- [ ] `useActiveThreadId()` → `useParams().threadId`.
- [ ] `useThreadData(id)` → cache lookup with loading/error tri-state
      (`undefined` = loading, `null` = error/not-found, value = ready).
- [ ] Sidebar highlight reads the URL (`useMatch` / params), not `selectedThreadId`.
- [ ] Migrate `activeThread` readers to `useThreadData(useActiveThreadId())`.
      The `useActive*` hooks in [thread-selectors.ts](../packages/client/src/stores/thread-selectors.ts)
      are already `@deprecated` in favor of `thread-context.tsx` — point them at
      the cache during migration, then delete.
- [ ] Compat shim: `selectedThreadId` getter derives from params; no new writes.

**Exit:** refresh on `/threads/B` shows B from cold store, no prior selection state.

### Phase 4 — Delete the reconciliation (1–2 days, HIGH risk)

Do these strictly in order, behind the flag (§4):

- [ ] Delete the invariant guard ([use-route-sync.ts:111-175](../packages/client/src/hooks/use-route-sync.ts#L111-L175)).
- [ ] Delete `selectGeneration`, `selectingThreadId`, `getSelectingThreadId`,
      `invalidateSelectThread` from [thread-store-internals.ts](../packages/client/src/stores/thread-store-internals.ts)
      (the `inflight` Map replaced them).
- [ ] Remove the `activeThread` single slot; readers use the cache.
- [ ] Verify `restoreLastRoute` only fires on cold start at `/` (it already gates
      on `restoredRef` + `isAnyRouteActive`).
- [ ] Hover prefetch (if any) calls `threadData.prefetch(id)` — never navigates.

**Exit:** no `invariant re-select` warn logs; rapid A→B→C lands on C with no title flicker.

### Phase 5 — (skip) FSM

funny has no pre-navigation confirmation flow for plain thread switches, so the
generic FSM phase is **not needed**. Branch checkout / worktree setup is already
modeled by [thread-data-machine.ts](../packages/client/src/machines/thread-data-machine.ts)
and the thread state machine in `@funny/shared` — leave them as-is.

### Phase 6 — Tests & observability (parallel)

- [ ] Extend [use-route-sync.test.tsx](../packages/client/src/__tests__/hooks/use-route-sync.test.tsx)
      (already modified in the working tree) to assert: click B → URL=B, no
      re-select of A; deep link; back/forward; rapid switch dedups; refresh.
- [ ] E2E (Playwright, `e2e/`): `thread switch does not ping-pong` — navigate to
      B, wait 500ms, assert still on B.
- [ ] Replace the `routeSyncLog.warn('invariant re-select', …)` log with a counter
      metric `navigation.thread_switch{from,to}` and `thread.load_ms{cache_hit}`.

**Exit:** suite green; zero reconciliation events in telemetry.

---

## 3. Anti-pattern checklist for PRs (funny)

Reject a PR if it:

- [ ] calls `selectThread()` directly from a component
- [ ] calls `navigate()` + `selectThread()` in the same UI handler
- [ ] adds an effect comparing URL to `activeThread` and "correcting" it
- [ ] writes `selectedThreadId` from UI
- [ ] adds a debounce for **correctness** (UX debounce on search is fine)
- [ ] reads `window.location` and `useLocation` both in selection logic without a rule
- [ ] reintroduces a single `activeThread` slot instead of `threadDataById[id]`

---

## 4. Migration safety: feature flag

```ts
// packages/client/src/config/features.ts
export const ROUTE_DRIVEN_THREADS =
  import.meta.env.VITE_ROUTE_DRIVEN_THREADS === '1';
```

Phase 2-4: new boundary + cache behind the flag; legacy guard active only when
`!ROUTE_DRIVEN_THREADS`. Retire the flag after Phase 4 ships clean.

---

## 5. Scratch threads (already a separate route — keep the rule)

funny already routes scratch threads at `/scratch/:threadId` and `/scratch/new`
([route-parser.ts](../packages/client/src/hooks/route-parser.ts), `ui-store.ts`).
`getThreadRoute(thread)` in [thread-variant.ts](../packages/client/src/lib/thread-variant.ts)
already builds both. So `goToThread` and `buildThreadPath` must delegate to that
predicate rather than re-deriving scratch vs project — same rule, no new branch.

---

## 6. Effort / risk summary

| Phase | Days | Risk | Rollback |
|---|---|---|---|
| 0 Inventory | ½–1 | none | — |
| 1 Nav facade | 1–2 | low | revert imports |
| 2 Boundary hydrator | 2–4 | medium | flag off |
| 3 Derive selection | 3–5 | medium | `selectedThreadId` shim |
| 4 Delete guard | 1–2 | **high** | flag keeps legacy guard |
| 6 Tests | parallel | — | — |

**Total: ~1.5–2.5 weeks**, incremental, no big bang. The high-value / high-risk
work is concentrated in Phases 3-4; Phases 0-2 are mostly already done or low-risk.

---

## 7. Definition of Done

- [ ] One module hydrates thread payloads from the URL (`ensureLoaded`).
- [ ] UI never writes `selectedThreadId` / never calls `selectThread`.
- [ ] `activeThread` single slot gone; detail view = `useThreadData(useActiveThreadId())`.
- [ ] Invariant guard, `selectGeneration`, `selectingThreadId` deleted.
- [ ] Refresh on any deep link (`/threads/:id`, `/scratch/:id`) works cold.
- [ ] WS message for an off-URL thread updates its cache, doesn't change the view.
- [ ] No `invariant re-select` in telemetry; rapid-switch test green.
