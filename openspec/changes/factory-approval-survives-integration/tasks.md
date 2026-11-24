# Tasks

## 1. Hold on a head that includes the base (D1)

- [x] 1.1 Add `updateBase()` to `factory-merge-lane.ts`: the update rounds of `bringUpToDate` without `checksOnNewHead`; verify with lane tests for behind (updated, `carried` filled), current (no call to GitHub's update), conflict (`sent-back`) and a base that keeps moving (`failed`)
- [x] 1.2 Split `mergeHeld` into `reviewHeld` and `riskHeld` in `factory-action-provider.ts` with no behavior change; verify the existing `factory-roles-provider` and `factory-watcher` tests pass unchanged
- [x] 1.3 In `provedMerge`, call `updateBase()` before holding a high-risk change that no approval covers (not where GitHub's merge queue is required); verify with provider tests: a behind head parks on the updated commit and its checks are not awaited, a current head pushes nothing, a conflict goes to `sentBack('conflict')`, a low-risk or approved change keeps today's order
- [x] 1.4 Document the order in `openwiki/architecture/issue-factory.md` (merge gate section); verify the page states that the hold is on a head that includes the base

## 2. The change's delta on the runner (D2)

- [x] 2.1 Add the `change-delta` request and result to the runner step protocol in `@funny/shared` and the server's step sender; verify `bun run typecheck` passes
- [x] 2.2 Implement `change-delta` in `packages/runtime/src/services/factory-steps.ts` with `gitRead` (merge base, `--is-ancestor`, per-file added / removed line multisets), returning a `Result`; verify with tests on a temporary repository: same change after a clean base merge is 0 lines, a conflict settled keeping both sides is 0, an extra commit counts its lines and files, 900 lines brought by the base count 0, a non-ancestor answers `ancestor: false`, a missing commit is an error
- [x] 2.3 Add the server port that asks the run owner's runner for the delta through `withRunnerFor` and the certified sink, mapping every failure to "not available"; verify with a test that an offline runner and an unknown step kind both give "not available" and that no other runner is tried

## 3. The approval follows the same change (D3, D5)

- [x] 3.1 Extend `factoryMergeApprovalSchema` with `riskKeys` and `moves`, and `carryMergeApproval` with the move it records; verify with `factory-runs` tests: the move is appended, `carriedFrom` keeps the first approved commit, and a concurrent new approval wins the compare-and-set
- [x] 3.2 Add `factory-approval-carry.ts` with the pure `approvalCovers` (same / adjustment / refusal with reason); verify with a table test of every branch in design D3
- [x] 3.3 Make `riskHeld` ask for the delta when an approval names another commit, move the approval on `same`, and put the refusal reason in the hold message; verify with provider tests: a weave-settled base merge with the same change merges without a second approval, a non-ancestor head holds, an unavailable delta holds
- [x] 3.4 Add the "member approves a held high-risk change" cases the spec now states to `factory-run-control` tests where missing (not waiting, no `steer`); verify they pass

## 4. The approval follows a small adjustment (D4, D7)

- [ ] 4.1 Return stable `keys` from `classifyRisk` and store them as `riskKeys` when a member approves; verify with `factory-risk` tests that a larger size keeps the key `size`, and a new sensitive path, finding or contract hint adds a key
- [ ] 4.2 Add `approval_adjust_max_lines` to `factory_settings` (migration, sqlite and pg schemas, `saveFactorySettingsInput` 0..200, `factory-settings.ts`); verify with a settings test for the default 0, the range and that saving needs `steer`
- [ ] 4.3 Pass the limit and both classifications to `approvalCovers` from `riskHeld`; verify with provider tests for each scenario of "A merge approval may follow a small adjustment" (7 lines pass, 852 hold, new file holds, new risk key holds, 40 then 30 against a limit of 50 holds, setting off holds, an approval without `riskKeys` only follows the same change)
- [ ] 4.4 Add the setting row to the factory settings with `SettingRow`, a `data-testid`, its `settings-index.ts` entry and a description saying the factory then merges lines no person read; verify `bun run lint` (`fitness:settings-index`) passes and a component test saves the value

## 5. The trace of a moved approval (D6)

- [ ] 5.1 Post the pull request comment and write the `factory.approval-moved` activity for the approver after a successful move; verify with tests: the comment names both commits, the files and the lines, a failed comment does not stop the merge and is logged, a lost compare-and-set posts nothing
- [ ] 5.2 Show the approved commit and its moves in the run detail of the factory board; verify with a component test for one `same` and one `adjustment` move
- [ ] 5.3 Describe both carry rules and the trace in `openwiki/architecture/issue-factory.md`, and the activity kind in `openwiki/architecture/background-activities.md`; verify both pages name the setting and its default

## 6. Paths of a run waiting for its approval (D8)

- [ ] 6.1 Add `hold_paths_awaiting_approval` to `factory_settings` (same migration as 4.2 when both land together), the contract and `factory-settings.ts`; verify with a settings test for the default `false`
- [ ] 6.2 Extend `busyPathsOf` for a run parked for a high-risk approval within `APPROVAL_PATH_HOLD_MS`, and the queue reason for a run that waits for it; verify with `factory-triage` tests for each new scenario of "Runs with overlapping paths do not work at the same time" (holds within 12 hours, lapses after, parked for another reason holds none, setting off holds none)
- [ ] 6.3 Add the setting row (`SettingRow`, `data-testid`, `settings-index.ts`) and a line in `openwiki/architecture/issue-factory.md`; verify `bun run lint` passes

## 7. Integration

- [ ] 7.1 Run `bun run lint`, `bun run typecheck` and the factory test suites of server, runtime and client; verify all pass
- [ ] 7.2 On the test-funny repository, with adjustments off: approve a high-risk run, move the base with a conflicting commit that weave settles, and verify the run merges without a second approval and the pull request has the automated comment
- [ ] 7.3 On the same repository, with adjustments at 50: after the approval push a 5-line commit in an approved file and verify it merges with the comment; push a commit in a new file and verify the run asks again with the reason in the hold message
