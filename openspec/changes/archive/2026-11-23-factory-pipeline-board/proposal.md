# Proposal

## Why

The issue factory now runs several agents per issue (triage, implementer, one reviewer per head commit, sentinel) and server gates (regression proof, test weakening, risk class, merge lane), but the factory view is a flat list showing one state badge per run. With most runs `merged`, a member cannot see what is in flight, where runs are stuck, or why a run is waiting, without opening each run. Almost everything needed is already in the `FactoryQueueRun` the client receives (`flowSteps`, `currentStep`, `triage`, `reviews`, `risk`, `regressionProof`, `metrics`, `waitReason`, `stepOptions`), so this is mostly client work.

## What Changes

- Add a **board layout** to the factory view: one column per pipeline stage (Queue, Triage, Implementing, PR · Proof · CI, Review, Merge, Needs a person, Done), each run placed by its `state`. The board is read-only: no drag and drop, since the server is the only writer of a run's state.
- Add a **list / board toggle** to the factory view. The current list stays and is the default.
- New **run card** used by the board: issue number and project, a step-by-step progress strip of the run's flow (done / current / failed / not reached, with the review round), chips for the quality gates (risk, head-commit review, regression proof, CI), and a one-line, plain-language reason when the run is waiting or needs a person.
- **Active runs first**: the Done column shows only runs completed in the last 24 hours and is collapsible; the list gets an "Active" filter and orders active and needs-a-person runs above finished ones.
- Column headers show the run count and, when the view is filtered to a single project, that factory's stage limit (e.g. Implementing 4/20, Merge 1 per repository).
- Extract a generic **board column** from the thread kanban (`KanbanColumnSurface` / `KanbanColumnHeader`), so both boards share the layout. The thread kanban behaves exactly as before.

No server, API or data-model change. Per-step timestamps (time spent in each stage) are out of scope; they need the server to record them.

## Capabilities

### New Capabilities

- `factory-pipeline-board`: how the factory view shows the pipeline: the board layout and its stage columns, the run card (progress strip, gate chips, waiting reason), the list / board toggle and the active-first ordering.

### Modified Capabilities

<!-- None: the issue factory's run behavior does not change. -->

## Impact

- `packages/client/src/components/FactoryQueueView.tsx`: toggle, active filter and ordering, board mount.
- New `packages/client/src/components/factory-board/` (board, column mapping, run card, progress strip, gate chips) and a pure stage-mapping module with unit tests.
- `packages/client/src/components/kanban/KanbanColumnHeader.tsx`, `KanbanColumn.tsx`: generic column extracted; thread kanban unchanged in behavior.
- `packages/client/src/lib/factory-run-labels.ts`: waiting / needs-a-person reason texts reused by the card.
- Locales (`en`, `es`, `pt`) for new strings; Storybook stories for the card and board.
- `packages/shared/src/contracts/factory.ts`: `FactoryQueueRun` is declared three times; collapse it to one declaration (no type change).
