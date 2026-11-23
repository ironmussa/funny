# Design

## Context

- The workflow engine journals every node execution of a factory run in
  `workflow_node_executions` (`runId`, `nodeId`, `visit`, `attempt`, `status`, `output`, `error`,
  `data`, `startedAt` / `finishedAt` as epoch ms), written by `journaledNodeTask`
  (`@funny/pipelines` `replay.ts`) when the execution starts and ends. The start is written after
  the node's concurrency slot is granted, so a slot wait is not inside any execution.
- Rows live as long as the run (FK, cascade). They are deleted only when a run is reopened from
  scratch (`factory-runs.ts`, the reopen path) so its flow runs again.
- The client reads runs from `factory.queueRuns` (polled every 15 s) and `factory.runs` (a
  project's list); both are `factory-runs.ts` reads (`queueForOwner`, `list`) mapped by the row
  mapper. Other answers that return a run (retry, stop) go through the same mapper.
- `output` and `data` can be large (a step's whole context); the timings must not read them.

## Goals / Non-Goals

**Goals:**

- Expose timings with one extra query per list read, never one per run.
- Client derivations pure and unit-tested, as for the board.

**Non-Goals:**

- Recording the slot wait itself (an engine change); it shows as the gap before a step.
- Keeping timings across a reopen-from-scratch (the journal is cleared on purpose).
- Timings on answers other than the two lists.

## Decisions

### D1. Read the journal at list time; optional field on the contract

`FactoryStepTiming = { step, visit, attempt, status, startedAt: ISO, finishedAt: ISO | null }`;
`FactoryRun.stepTimings?: FactoryStepTiming[]`, absent on answers that do not look it up (the
`incident` pattern). `factory-runs.ts` gets `stepTimingsFor(runIds)`: one `SELECT run_id, node_id,
visit, attempt, status, started_at, finished_at FROM workflow_node_executions WHERE run_id IN (...)
ORDER BY started_at` (chunked for SQLite's parameter limit), grouped by run, merged into the mapped
runs of `list` and `queueForOwner`. Statuses outside the contract's enum are dropped (defensive, the
journal's own enum is the same today). Alternative, new columns on `factory_runs` written by
`onStateChange`: rejected, it duplicates what the journal holds and needs a migration and new
writers.

### D2. Stage of a step

`step-stage.ts` maps the built-in flows' node ids to board columns (`triage`; `implement`,
`address`; `pull-request`, `regression-proof`, `ci`; `review`; `merge`); a retry's
`<node>.before_retry` counts for its node. Other nodes count nowhere (a repository flow naming its
nodes differently gets no medians, the same fallback as the stage limits).

### D3. Pure derivations

`step-timings.ts`:

- `timeInCurrentStep(run, now)` → `{ kind: 'in-step', since } | { kind: 'waiting', since } | null`:
  the latest execution of `currentStep` (running or not) gives `in-step`; none gives `waiting`
  since the latest finished execution; no timings, no current step, or a state outside the active
  columns gives null.
- `stepTimeline(run, now)` → executions in order, each with its duration (running: up to `now`)
  and the gap before it when it is 60 s or more.
- `stageMedians(runs, now)` → per column, the median over runs of the sum of their executions of
  the stage's steps that finished in the last 7 days.
  Durations format with the existing `formatActionDuration`.

### D4. Where it shows

`FactoryRunCard` adds the time line next to its waiting line; `FactoryBoardStage` shows the median
in `headerExtra` (with a tooltip "median over 7 days"); the panel gets a `RunTimeline` section after
the flow. All read `run.stepTimings` and render nothing without it.

## Risks / Trade-offs

- [A list of many runs reads many journal rows] → one query with only small columns; a run has
  tens of executions at most (loops are capped); the queue lists runs of the last 14 days.
- [Clock: `startedAt` is the server's clock and `now` the browser's] → the card's "since" can be off
  by the clock skew; the same holds for the board's relative times today. Durations between two
  server times are exact.
- [A reopen-from-scratch empties the timeline] → documented; the timeline shows what ran since.

## Migration Plan

No migration (the journal exists). Server and client deploy together; an older client ignores the
new field, a newer client with an older server shows no timings.
