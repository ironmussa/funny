# Design — grid-thread-actions

## Context

The grid view is mounted as an `absolute inset-0 z-10` overlay **inside the `thread` slot** of `CenterDockview`, which itself sits inside the app-level `<ThreadProvider threadId={activeThreadId}>` (App.tsx). The right pane (`ReviewPane` / `ProjectFilesPane` / `CommentsPane` / `ActivityPane`) is a **sibling dockview slot** and reads its thread/project from that same `ThreadProvider`.

Two facts drive the whole design:

1. The right pane is **global and single**, keyed to the URL-derived `activeThreadId`. The grid has no URL per cell.
2. The right pane is **explicitly suppressed** while the grid is open: `rightPaneVisible = reviewPaneOpen && !isFullScreenView`, and `liveColumnsOpen ⟹ isFullScreenView`.

So to make the grid's header icons drive the real right pane scoped to a selected thread, we need (a) a selected-thread concept, (b) an "effective thread" override that feeds the selected thread into the app thread context while the grid is open, and (c) to stop suppressing the right pane in that case. Because the grid overlay only covers the `thread` slot, the right pane can appear to its right with no z-index fight.

## Goals / Non-Goals

**Goals**

- One consolidated action bar in the grid header, operating on a selected thread.
- Review/files/comments/etc. open the existing global right pane, scoped to the selected thread, identical to the main view (tabs, resize, gating).
- Click-to-select, auto-select-first, clear-on-remove, persisted selection.

**Non-Goals**

- No per-grid independent right pane (rejected — see below).
- No change to what the panes themselves do, or to git/scratch gating.
- No multi-select. Exactly one selected thread at a time.
- No server/runtime/shared changes.

## Decision 1 — Reuse the global right pane (not a grid-local pane)

**Chosen: reuse the global right pane** by overriding the app-level thread context with the grid selection while the grid is open.

```
App.tsx
  effectiveThreadId = liveColumnsOpen ? gridSelectedThreadId : activeThreadId
  <ThreadProvider threadId={effectiveThreadId}>
    CenterDockview
      thread slot ─→ LiveColumnsView overlay (its own per-cell ThreadProviders)
      right  slot ─→ ReviewPane/Files/Comments  ← reads effectiveThreadId
  </ThreadProvider>
  rightPaneVisible = reviewPaneOpen && (!isFullScreenView || (liveColumnsOpen && !!gridSelectedThreadId))
```

- The per-cell `ThreadColumn`s each wrap their own `ThreadProvider`, so overriding the **outer** provider only affects the header + right pane — never the cells' own streams.
- Tabs (Changes/History/Stash/PRs/Issues), resize, persistence, and `canDoGitOps`/scratch gating are inherited with zero new code.

**Rejected: grid-local right pane.** Mount a second right-pane composition inside `LiveColumnsView` under `ThreadProvider(selected)`. Avoids touching App.tsx but **re-implements** the dockview right-tabs + resize + visibility — duplicated layout that will drift from the canonical one. Not worth it for a client-only feature whose whole point is "behave exactly like the main view."

## Decision 2 — Selection state lives in `ui-store`, persisted

`gridSelectedThreadId` must be readable by **both** `App.tsx` (effective thread + pane visibility) and `LiveColumnsView` (header binding + cell highlight), so it belongs in `ui-store` next to `liveColumnsOpen`.

- **Persisted** to `localStorage` (`funny:grid-selected-thread:v1`) so it survives reload, consistent with `funny:grid-cols/rows/cells`.
- Ephemeral React state in `LiveColumnsView` was considered but rejected: App.tsx can't read it, and the user asked for persistence.

## Decision 3 — Extract `ThreadHeaderActions` from `ProjectHeader`

The action cluster (`<div className="flex shrink-0 items-center gap-2">` holding startup/preview/terminal/review/tests/files/comments/share/more) is extracted into `ThreadHeaderActions`, consumed in two places:

- `ProjectHeader` (main view) — renders it inline; **no behavior change**.
- `LiveColumnsView` header — renders it under `ThreadProvider(gridSelectedThreadId)`, with grid-appropriate `hide*` flags (mirror what `ThreadColumn` passed: e.g. hide startup/terminal/timeline as today).

This keeps a single source of truth for the icons and their wiring (they read the thread from context, so binding = wrapping in the right provider).

## Selection lifecycle

| Event                                                               | Behavior                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Grid mounts / cells load                                            | Auto-select the **first cell index (row-major) that holds a thread**; none if grid empty.                          |
| Click a cell with a thread                                          | Select that thread; highlight its border.                                                                          |
| Selected thread removed from grid                                   | **Clear** selection (then optionally re-run auto-select-first? — see Open Question).                               |
| Columns collapse / reshuffle (`handleRemoveFromGrid`, drag reorder) | If the selected thread is no longer placed, clear.                                                                 |
| Reload                                                              | Restore from `localStorage`; if the stored id is not currently placed in the grid, fall back to auto-select-first. |

The "first cell that holds a thread" auto-select means a 1×1 grid always has its single thread selected, so the header is never empty when content exists.

## Right-pane visibility nuance

`rightPaneVisible` gains the grid case. But `isFullScreenView` is still used for hiding `ProjectHeader`, the overlay z-index, and `SidebarAwareDockview` layout. We do **not** remove grid from `isFullScreenView` wholesale — we only special-case the right pane:

```ts
const rightPaneVisible =
  reviewPaneOpen && (!isFullScreenView || (liveColumnsOpen && !!gridSelectedThreadId));
```

Need to confirm `SidebarAwareDockview` / `CenterDockview` honor `rightPaneOpen` independently of the `isFullScreenView` prop they also receive — if that prop forces the right slot closed during full-screen, it must be relaxed for the grid case too.

## Open question (to resolve in implementation)

- **Clear-then-reselect vs clear-and-leave-empty** when the _selected_ cell is removed: the user chose "clear." Strict clear leaves the header empty until the next click; an ergonomic tweak is to clear then auto-select the new first-with-thread. Default to **strict clear** (matches the stated decision); revisit if it feels abrupt.

## Risks

- **App.tsx blast radius.** `effectiveThreadId` + `rightPaneVisible` are central; a wrong override could leak the grid selection into the non-grid view. Mitigation: the override is strictly gated on `liveColumnsOpen`, and covered by a test asserting the main view still uses `activeThreadId`.
- **Stale persisted selection.** A persisted id for a thread no longer in the grid (or deleted) must not break the header — handled by the auto-select-first fallback + null-safe header (icons disabled when no valid selection).
