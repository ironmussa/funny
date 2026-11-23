# Tasks

## 1. Contract and server

- [x] 1.1 Add `FactoryStepTiming` and optional `FactoryRun.stepTimings` to `packages/shared/src/contracts/factory.ts`; verify with `bun check -p packages/shared/tsconfig.json`.
- [x] 1.2 Add `stepTimingsFor(runIds)` to `factory-runs.ts` (D1: one chunked query of the small columns, grouped by run, unknown statuses dropped) and merge it into `list` and `queueForOwner`; server test: a run with a loop and a retried step returns its entries in start order without outputs, a queued run has none, other runs' rows do not leak in, more run ids than one chunk.
- [x] 1.3 Document the timings in `openwiki/architecture/issue-factory.md` (where they come from, which answers carry them, the reopen limitation).

## 2. Client derivations

- [x] 2.1 Add `factory-board/step-stage.ts` (D2) and `step-timings.ts` (D3) with unit tests for every spec scenario: long review, waiting for the merge slot, no timings, a retried step, a wait of 15 min and one under a minute, the 40 min review median, executions older than 7 days ignored, unknown nodes ignored.

## 3. UI

- [x] 3.1 Show the time in the current step on `FactoryRunCard` and the median in the stage column headers; component tests for both and for a run without timings.
- [x] 3.2 Add the `RunTimeline` section to the run panel; component test for the retried-step-and-wait scenario.
- [x] 3.3 Add the `en`, `es`, `pt` strings; extend the board and panel stories with timings.

## 4. Verification

- [x] 4.1 Run `bun run lint`, `bun run typecheck`, the server factory tests, the client suite, the factory stories and `bunx fallow audit --base origin/master`; all pass.
- [ ] 4.2 Check the card, headers and timeline in Storybook in light and dark themes and at the smallest and largest font sizes.
