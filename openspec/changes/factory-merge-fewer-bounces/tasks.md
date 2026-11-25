# Tasks

## 1. A refused merge is tried again (D1)

- [x] 1.1 Read run 630d1fc5's `merge` step in the server log of 2026-11-25 01:32 and record in design.md whether the base, the head or neither had moved when GitHub answered 405; verify the note names the two commits
- [x] 1.2 Add `movedSince(sha)` to the merge lane (head, base, neither, or null when unreadable); verify with `factory-merge-lane-update-base` tests for the three answers
- [x] 1.3 Make `merge` go back through `upToDate` and merge again when a branch moved, at most `MAX_STALE_MERGES` (3) refusals per visit, then park with the hold reason `base keeps moving` (label and detail in the client, three locales); verify with `factory-action-provider` tests for one retry that merges and never parks, three refusals that park, and a refusal with neither branch moved that is not retried
- [x] 1.4 The approval on a retried merge is re-decided by `upToDate` → `mergeHeld` → `approvalNotMoved` on the new head, the path the carry tests of `factory-roles-provider` already cover; no new code
- [x] 1.5 Keep GitHub's message in a pinned merge's refusal reason (today only the status survives); verify with a `github-app-check-runs` test on a 405 carrying a message

## 2. The approval gap (D2, D3)

- [x] 2.1 Add `gap` to `factoryMergeApprovalSchema`, `MAX_APPROVAL_GAP_FILES` and `approvalGapFor(approval, heldSha)` in `@funny/shared/contracts/factory`
- [x] 2.2 Add the pure `approvalGapOf` to `factory-approval-carry.ts`; verify with tests for a file outside the approved change, new risk keys, more than 20 files, and a comparison that is not available
- [x] 2.3 Add `noteApprovalGap` to the runs repository (compare-and-set on the stored approval) and drop the gap in `carryMergeApproval`; call it from `approvalNotMoved` when the approval does not cover; verify on the run table (written only for the approval it names, read only for its commit, gone after a new approval and after a carry) and at the merge gate (a refusal records it, a followed approval records none)
- [x] 2.4 Add `sinceApproval` to `funny_factory_runs` (server summary and the runner's `describeRun`); verify with `factory-agent-tools` and `agent-factory-tools` tests
- [x] 2.5 Pin D3: approving the held commit replaces the record, so a later adjustment starts from it (the run-table test of 2.3)

## 3. Showing the gap (client)

- [x] 3.1 `ApprovalGapNote` on `FactoryApprovalRequestCard`, above the reasons (commits and paths in monospace, files outside the approved change marked, the compare link labelled "Commits since the approval"); verify with component tests for a gap, no gap, a gap of another commit and `lines: null`
- [x] 3.2 The same note in the run detail panel above the risk, and "Asks again after N lines changed" on the board card; verify with component tests for the two scenarios of "The run panel shows what changed since an approval"
- [x] 3.3 Add the strings in the three locales

## 4. Paths (D5, D6)

- [x] 4.1 Make `pathsHeld` and triage's path wait not hold a run that has a pull request; verify with `factory-stacking` and `factory-triage` tests
- [x] 4.2 Migration 128 and the `holdPathsAwaitingApproval` setting (schemas, contract, `factory-settings.ts`); extend `busyPathsOf` for a run parked for a high-risk approval within `APPROVAL_PATH_HOLD_MS`, read the parked runs in triage (`awaitingApproval`), and the wait reason `paths-awaiting-approval`; verify with `factory-stacking` tests for each scenario of "Runs with overlapping paths do not work at the same time" and a `factory-trpc` test for the setting
- [x] 4.3 Add the setting row (`Switch`, `data-testid`, `settings-index.ts`) next to the approval adjustment in `ProjectFactoryMergeRows.tsx`

## 5. The earlier change and the docs

- [x] 5.1 Remove group 6 from `factory-approval-survives-integration/tasks.md`, D8 from its design.md (leaving a pointer here) and the MODIFIED "Runs with overlapping paths" requirement from its spec delta; verify `openspec validate factory-approval-survives-integration --strict` passes
- [x] 5.2 Update `openwiki/architecture/issue-factory.md` (refused merges, the approval gap, the two path rules); verify `openspec validate factory-merge-fewer-bounces --strict` passes

## 6. Verification

- [x] 6.1 Run `bun run lint`, `bun run typecheck` and the factory test suites of server, runtime, core and client; verify all pass
- [ ] 6.2 On test-funny: approve a high-risk run, push a commit to the base right before its merge, and verify it merges without parking and with the approval-moved comment
- [ ] 6.3 On test-funny: approve a run, push a small commit in a file its change did not touch, and verify the new hold's card and panel show the approved commit, the lines, the file marked as new and the reason; approve it and verify it merges
- [ ] 6.4 On test-funny: with two runs on the same file, the first approved and retried while the second works, verify the first merges first; then turn the setting on and verify a third run waits with the approval reason
