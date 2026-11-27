# Tasks

- [x] 1 Add `not_actionable` to the triage result and stored triage, and `heldForPaths` to the stored triage (`@funny/shared/contracts/factory-spec`).
- [x] 2 Triage: offer `not_actionable` in the prompt, close on evidence with GitHub's reason (`completed` / `not_planned`), park when the close fails. Verified in `factory-triage.test.ts`.
- [x] 3 Store the held mark with the `hold` transition, and triage again when a run merged on the contract's paths (`mergedPathsSince`). Verified in `factory-triage.test.ts`, `factory-trpc.test.ts` and `factory-watcher.test.ts` (two issues, the first merges).
- [x] 4 Board: chip, waiting text and run detail for `not_actionable` (en / es / pt).
- [x] 5 `openwiki/architecture/issue-factory.md`: the triage row.
