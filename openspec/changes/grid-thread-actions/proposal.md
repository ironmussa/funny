## Why

In the grid view (`LiveColumnsView`), each cell renders a full `ProjectHeader` carrying the per-thread action icons (review/diff, comments, share, more, remove). This has two problems:

1. **The action icons are duplicated per cell and clutter every column header**, leaving little room for the title in a narrow column.
2. **Half of them are inert in grid.** The review and comments icons toggle the global `reviewPaneOpen` / `rightPaneTab` flags, but the grid is rendered as a full-screen overlay and the global right pane is explicitly suppressed while it is open (`rightPaneVisible = reviewPaneOpen && !isFullScreenView`, and `liveColumnsOpen` makes `isFullScreenView` true). Clicking them does nothing visible.

We want **one** set of action icons in the grid's own view header — next to the grid-size picker — that operates on a **selected thread**, and we want those actions (review, files, comments, etc.) to open the **real** right pane, exactly as they do in the main thread view, scoped to the selected thread's project/worktree.

## What Changes

- **New concept: a selected thread in the grid.** Clicking a cell selects its thread; the selected cell shows a highlighted border. `gridSelectedThreadId` is persisted to `localStorage` (survives reload, like the rest of the grid layout). On mount, the first cell that holds a thread is auto-selected. Removing or reshuffling the selected cell clears the selection.
- **Action icons move to the grid view header.** The cluster of action icons currently in `ProjectHeader` (review, project-files, tests, comments, share, more-actions) is extracted into a reusable `ThreadHeaderActions` component, mounted once in the grid header under a `ThreadProvider` bound to `gridSelectedThreadId`, and **removed from the per-column headers**. Each column header keeps only its drag-handle, status icon, title, and the per-cell remove (`✕`).
- **The global right pane is reused for the selected thread.** When the grid is open and a thread is selected, the app-level thread context resolves to the selected thread and the right pane is allowed to render alongside the grid (it lives in a sibling dockview slot, not under the grid overlay). All existing panes — Changes/History/Stash/PRs/Issues tabs, Project Files, Comments, Activity — and their resize/persistence come for free.
- **Gating is inherited.** If the selected thread is a scratch thread (no git), `canDoGitOps` already disables review/files and leaves comments/more — identical to the main view. No new gating logic.

## Capabilities

### New Capabilities

- `grid-thread-actions`: grid-view thread selection (click-to-select, auto-select-first, clear-on-remove, persisted), a consolidated header action bar bound to the selected thread, and reuse of the global right pane scoped to the selected thread while the grid is open.

## Impact

- **`packages/client/src/stores/ui-store.ts`** — add `gridSelectedThreadId: string | null`, a `setGridSelectedThreadId` setter, and `localStorage` persistence (key e.g. `funny:grid-selected-thread:v1`).
- **`packages/client/src/components/thread/ProjectHeader.tsx`** — extract the right-side action-icon cluster into a new `ThreadHeaderActions` component (no behavior change for the main view, which keeps rendering it inline).
- **`packages/client/src/components/LiveColumnsView.tsx`** — render `ThreadHeaderActions` in the view header (under `ThreadProvider(selectedThreadId)`), next to the `GridPicker`; manage auto-select / clear-on-remove; thread `gridSelectedThreadId` into the cell rendering for the highlighted border.
- **`packages/client/src/components/live-columns/ThreadColumn.tsx`** — drop the action icons from the column `ProjectHeader` (keep drag-handle, status, title, remove-`✕`); add a click-to-select affordance + selected-border styling.
- **`packages/client/src/App.tsx`** — compute an `effectiveThreadId` (= `gridSelectedThreadId` when `liveColumnsOpen`, else `activeThreadId`) for the app-level `ThreadProvider`; relax `rightPaneVisible` to allow the right pane while the grid is open and a thread is selected.
- **Tests** — selection lifecycle (auto-select-first, clear-on-remove, persistence round-trip); right-pane visibility in grid; header actions operate on the selected thread.
- **No server / runtime / shared changes** — this is client-only UI wiring over existing panes and predicates.
