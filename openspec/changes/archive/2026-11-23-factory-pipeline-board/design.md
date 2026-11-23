# Design

## Context

- `FactoryQueueView.tsx` renders `useFactoryQueueRuns()` (every run of the caller's factories, with `projectId`) as a filtered list (search, project filter, state filter via `filterFactoryRuns`). Labels and wait-reason texts live in `lib/factory-run-labels.ts`.
- The thread kanban (`KanbanView.tsx`, `components/kanban/`) has the board layout, but `KanbanColumnSurface` / `KanbanColumnHeader` take a `ThreadStage` (for title, test id, add-thread button) and `KanbanColumn` takes `Thread[]` plus drag-and-drop wiring.
- A run's server-side `stage` (`factory-thread-stage.ts`) collapses most active states into `in_progress`, so the board maps from `FactoryRun.state` directly.
- Stage limits come from `FactorySettings` (`maxConcurrent`, `stageLimits` keyed by flow node id; merge is fixed at one per repository), read per project with `useFactorySettings(projectId)`.
- Per-step start / end times are not recorded; the strip is derived from `flowSteps`, `currentStep`, `state` and `reviews`.

## Goals / Non-Goals

**Goals:**

- All mapping logic (state → column, run → step marks, run → gate chips, run → waiting reason) in pure functions with unit tests, so components stay thin.
- One shared column primitive for both boards.

**Non-Goals:**

- No server, contract or query change (besides collapsing the triplicated `FactoryQueueRun` declaration).
- No drag and drop, no column reordering, no per-stage durations, no run detail panel (a later change).

## Decisions

### D1. Map from `state`, not from the run's thread stage

`factoryBoardColumn(state)` in `components/factory-board/board-columns.ts` is a total function over `FactoryRunState` with a `needs_person` fallback for unknown strings. A `satisfies Record<FactoryRunState, ColumnId>` table makes a new state a type error until it is placed. Alternative, reusing `RUN_STAGE`: rejected, it loses the steps the board exists to show.

### D2. Extract a generic `BoardColumn` from the kanban

Move the surface into `components/board/BoardColumn.tsx`: props `id` (test id suffix), `title: ReactNode`, `count`, `headerExtra?: ReactNode`, `columnRef?`, `scrollRef?`, `highlighted?`, `collapsed?`, `children`. `KanbanColumnSurface` becomes a thin wrapper that passes the stage label, the add-thread button as `headerExtra`, and keeps `data-testid="kanban-column-${stage}"`. Drag-and-drop stays in `KanbanColumn`. Alternative, making `KanbanColumn` generic over item type: rejected, its drag, highlight and pagination logic is thread-specific and the factory board needs none of the drag part.

### D3. Card derivations are pure modules

- Step marks reuse the existing `factoryRunSteps(run)` in `lib/factory-run-labels.ts` (done / current / failed / pending, already used by the run views). `run-progress.ts` only adds what the strip needs on top: `round` on a review step (`reviews.length + (state === 'reviewing' ? 1 : 0)`, counting the round in progress) and the agent options (the last `stepOptions` entry whose `stepId` is the step).
- `run-gates.ts`: `runGateChips(run)`; the head commit is `risk.headSha` when known, else the latest review's SHA; a review or proof for another SHA (and not `carriedFrom` it) is `stale`.
- `run-waiting.ts`: `runWaitingReason(t, run)`, reusing `factoryWaitReasonText` for the queue and `factoryRunReasonText(run.failureReason)` for `waiting_human` / `failed` (the server already records the merge gate's reason there).
- The review chip reuses `factoryRunReviewLabel` (a review with only non-blocking findings passes).

### D4. Layout toggle and persistence

A `ToggleGroup` (shadcn, install if missing) in the toolbar, `data-testid="factory-view-layout-list|board"`. The choice is UI state in a small Zustand slice persisted under `funny:factory-view-layout` at the `stores/` boundary (not in `src/data/`, per the data-layer rule). The Active filter is an `activeOnly` option of `filterFactoryRuns`, whose existing order (waiting, active, queue, failed, ended) the list keeps.

### D5. Limits only for one project

The board calls `useFactorySettings(projectId)` only when the project filter holds exactly one project. Implementing limit: `stageLimits.implement ?? maxConcurrent`; Review: `stageLimits.review ?? maxConcurrent`. Node ids are the built-in flow's; for a repository flow without those node ids the header falls back to `maxConcurrent`. Alternative, summing limits across projects: rejected, it is not a real limit of anything.

### D6. Rendering cost

Columns render at most 50 cards and then a "show more" button (the kanban's `LoadMoreSentinel` pattern). Cards are `memo` keyed on `run.id` + `updatedAt`. The relative time uses the view's existing `now` tick.

## Risks / Trade-offs

- [The strip marks steps from their order; in a loop (review → address → review) a step before the current one reads as done even when it was skipped on the first pass] → accepted: it is `factoryRunSteps`' existing behavior, shared with the run views; the review round count shows the loop.
- [Repository flows can name nodes differently, so limits may show `maxConcurrent` instead of the node's own] → documented fallback; the header tooltip says which setting the number comes from.
- [Hiding old Done runs could look like data loss] → the Done header shows the hidden count and links to the list with the Done states filtered.

## Migration Plan

Client-only, list remains the default layout; rollback is reverting the change. No data migration.
