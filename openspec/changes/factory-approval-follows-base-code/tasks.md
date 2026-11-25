# Tasks

## 1. Runner: the base's change and the new delta fields

- [x] 1.1 In `runtime/services/factory-change-delta.ts`, parse the base's change from fork(A) to fork(B) and compute `baseBrought` (D1). Verify with unit tests on `parseChange` inputs: a file the base added and the change fixes is base-brought; a file where the change removes a line from before fork(A) is not; a file the base did not change is not.
- [x] 1.2 Compute `linesAcrossMoves` (D2), pairing same-sign lines only into base-brought files. Verify with unit tests: an edit moved from F to a base-brought G counts 0; a line moved between two files A touched still counts 2.
- [x] 1.3 Add `baseBrought` and `linesAcrossMoves` to `ChangeDeltaResult` and return them from `changeDelta`. Verify with a git-repo test (the existing change-delta test fixtures) that reproduces the #478 shape: the base splits a file and adds a new warning, and B fixes both.

## 2. Server: the carry decision and its record

- [x] 2.1 Add the two optional fields to `changeDeltaResultSchema` and `ChangeDelta` (`factory-step-runner.ts`). Verify that a result without them still parses (test).
- [x] 2.2 Apply D4 in `approvalCovers`, and add `baseBrought` to the adjustment verdict and to `approvalGapOf`. Verify with `factory-approval-carry` tests, one per new spec scenario, plus the old-runner fallback.
- [x] 2.3 List the base-brought files in the approval-moved PR comment, the `factory.approval-moved` activity input and the `ApprovalGapNote` (client, en/es/pt strings). Verify with the existing comment/activity tests and a client test of the gap note.
- [x] 2.4 Update `openwiki/architecture/issue-factory.md` (approval carry section) with the base-brought rule. Verify by reading the section against the spec.

## 3. Integration

- [x] 3.1 Run `bun run lint`, `bun run typecheck` and the factory server, runtime and client test suites. Verify they pass.
- [x] 3.2 Replay the three real cases (#478 345d759→7143861, #450 4a5270b→cb1890e, #458 97bc2b9→fe30976) through `changeDelta` + `approvalCovers` with a 100-line limit. Verify that all three are covered, and that #478 is refused at a 90-line limit.
