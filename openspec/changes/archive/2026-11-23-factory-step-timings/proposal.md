# Proposal

## Why

The factory board and run panel (`factory-pipeline-board`) show where each run is, but not for how
long. A member cannot tell a review that started a minute ago from one stuck for three hours, which
stage is the bottleneck over a week, or whether a run in the Merge column is merging or still
waiting for the repository's merge slot. The server already records every node execution of a
run's flow with its start and end (`workflow_node_executions`, the workflow engine's journal), but
nothing exposes it.

## What Changes

- **The run lists carry the run's step timings** (`stepTimings`): one entry per node execution
  (step, visit, attempt, status, started, finished), read from the journal the engine already
  writes. Only the list answers (the factory view's queue and a project's run list) carry it, like
  `incident`; no new table, no new write.
- **Board card:** how long the run has been in its current step ("in review 2 h"). In Merge it
  says whether the run is waiting for the merge slot (no execution of the step started yet) or
  merging.
- **Run panel:** a timeline of the step executions with their duration, status and attempt, and
  the waits between them (time between one step ending and the next starting: a slot or a queue).
- **Board column headers:** the median time runs spent in that stage over the last 7 days.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `issue-factory`: the run lists expose each run's step executions with their times.
- `factory-pipeline-board`: time in the current step on the card, the step timeline in the panel,
  and the median time per stage in the column headers.

## Impact

- `packages/shared/src/contracts/factory.ts`: `FactoryStepTiming`, optional `FactoryRun.stepTimings`.
- `packages/server/src/services/factory/factory-runs.ts` (`list`, `queueForOwner`): one batched read
  of the listed runs' executions (only the columns needed, not outputs); a test.
- Client: `components/factory-board/` (stage of a step, time in step, column medians, timeline
  section), with unit and component tests; locales; stories; openwiki.
- Limitation: a run reopened from scratch loses its journal, and so its timings (the engine deletes
  them so the flow runs again); a waiting time before a step is shown as a gap, since the engine
  does not record the slot wait itself.
