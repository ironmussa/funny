# Tasks

## 1. Shared column and contract cleanup

- [x] 1.1 Collapse the three `FactoryQueueRun` declarations in `packages/shared/src/contracts/factory.ts` into one; verify with `bun check -p packages/shared/tsconfig.json`.
- [x] 1.2 Extract `components/board/BoardColumn.tsx` (D2) and make `KanbanColumnSurface` a wrapper over it, keeping `kanban-column-${stage}` test ids and the add-thread button; verify the existing kanban tests and `KanbanView` stories render unchanged.

## 2. Pure derivations

- [x] 2.1 Add `components/factory-board/board-columns.ts` (`factoryBoardColumn`, column order, Done 24-hour window, per-column ordering) with unit tests for every `FactoryRunState`, an unknown state, and the old-Done hidden count.
- [x] 2.2 Add `run-progress.ts` (review round and agent options over `factoryRunSteps`, D3) with unit tests: second review round, round in progress, options of a step that ran twice, no `flowSteps`.
- [x] 2.3 Add `run-gates.ts` (`runGateChips`) with unit tests: no results, high risk with reasons, stale review after a new commit, carried-from proof, CI red rounds and conflicts.
- [x] 2.4 Add `run-waiting.ts` (`runWaitingReason`) reusing `factoryWaitReasonText` and `factoryRunReasonText`, with unit tests for a queue wait, `needs_info` question count, `failed`, `no_change`, `waiting_human` with and without a recorded reason; add the `en`, `es`, `pt` strings.
- [x] 2.5 Add the `activeOnly` option to `filterFactoryRuns` with unit tests (hides merged, no_change, stopped; keeps the order).

## 3. Card and board

- [x] 3.1 Build `FactoryRunProgress` (strip with hover / focus tooltip of provider, model, effort) and `FactoryRunGateChips` using `LabelBadge` and shadcn `Tooltip`, with `data-testid`s; add Storybook stories for each mark and chip state.
- [x] 3.2 Build `FactoryRunCard` (issue link, project, PR link, relative time, strip, chips, waiting line; activating opens `implementingThreadOf(run)` or the latest thread), with a component test for the open behavior and a story.
- [x] 3.3 Build `FactoryBoard` from `BoardColumn`: columns per D1, counts, collapsible Done with its hidden-count link to the list, 50-card pages, limits per D5 when one project is selected; component tests for placement, limits with one vs two projects, and that cards are not draggable.

## 4. Factory view integration

- [x] 4.1 Add the list / board toggle (D4, persisted layout) and the Active filter to the `FactoryQueueView` toolbar; apply the new ordering to the list; verify with a component test that filters apply to both layouts and the layout survives a remount.
- [x] 4.2 Document the board in `openwiki/architecture/issue-factory.md` (what each column holds, what the strip and chips derive from, the no-drag rule).

## 5. Verification

- [x] 5.1 Run `bun run lint`, `bun run typecheck` and the client test suite; all pass.
- [x] 5.2 Check the board in Storybook with a fixture of runs in every state, in light and dark themes and at the smallest and largest font size settings.
