# Tasks

Prerequisites: `workflow-dag-engine` groups 1–3 (executor, loops, concurrency groups, journal), which is archived, and `factory-flow-step-options` groups 1–3 (per-step options and `thread: new`), which is **not implemented yet** (0 of its 23 tasks). Groups 1, 2 and 5 here do not need it. Group 6 does: the `review` step needs a read-only new-thread launch (`thread: new`, step-options 3.2) and `prompt_file` (step-options 1.3, 2.4).

Delivery is in two phases (design D14). **Phase 1** is groups 1, 2, 5, 6 and 7, closed by 9.5: the reviewer and the merge lane, deployable alone. **Phase 2** is groups 3, 4 and 8: triage and the contract, path reservation and the sentinel. Group numbers are the ones of the first version of this file, because `factory-integration` refers to groups 6–7; that is why the groups below are not in numeric order.

# Phase 1: reviewer and merge lane

## 1. Structured role results

- [x] 1.1 Add the review result schema (zod) to `@funny/shared/contracts/factory`, carrying `sha` and findings with severity (the triage schema is 3.6, the sentinel's 8.4); verify with schema tests for valid, missing-field and wrong-severity results
- [x] 1.2 Add a server reader that takes a thread's final message, extracts the last fenced `json` block and validates it against a role schema, with one re-emit follow-up on failure; verify with unit tests for no block, two blocks (last wins), invalid then valid, invalid twice
- [x] 1.3 Document the result contract in `openwiki/architecture/issue-factory.md`; verify the doc's file references exist

## 2. Run states and storage

- [x] 2.1 Migration in `server/src/db/migrate.ts` and both schemas: `factory_runs` verdicts (per SHA) and risk class, new states `reviewing` / `merging`; `factory_settings.auto_merge`, `sensitive_paths` and `stage_limits` (the contract, likely paths, `triaging` and `needs_info` are 3.7); verify with the migrate test (`bun run db:push` was not run: its config writes to `~/.funny/data.db` and cannot target a scratch DB; the migration test runs `autoMigrate` on an in-memory DB instead)
- [x] 2.2 Extend the run machine in `factory-runs.ts` with `reviewing` and `merging` (including a run waiting for the merge slot) as compare-and-sets; verify with transition tests including a refused transition from a wrong state
- [x] 2.3 Map the new states and fields in the `factory` tRPC port and `@funny/shared/contracts/factory`; verify with `factory-trpc` tests reading a run in each new state
- [x] 2.4 Add the run machine changes to `docs/architecture/state-machines.md`

## 5. Test-weakening check and risk class

- [x] 5.1 Add the test-weakening check over a pull request's file list and patch (removed tests, skip / focus markers for TS/JS and Python, coverage thresholds, `.github/workflows/`), run on each head commit when its checks start; verify with fixture-diff unit tests for each finding and a clean diff
- [x] 5.2 Add the risk classifier (findings, > 400 changed lines, default and configured sensitive paths, and the contract's risk hints when the run has a contract); verify with unit tests per rule, a run without a contract, and that a review result cannot change it
- [x] 5.3 Add pull request file list / patch reads to `@funny/core/github-app` if missing; verify with its tests

## 6. Review gate

- [x] 6.1 Add the `review` step kind (accepting only `provider` / `model` / `effort` / `early`; `prompt_file` arrives with `factory-flow-step-options`) and refuse write permission modes on it at load; verify with schema tests and a factory-flow load test naming step and field
- [x] 6.2 Run `review` on a new read-only thread per head SHA with the contract (the issue URL when the run has none), the commit, the PR body, the test-weakening report and the factory's recent / in-flight PRs; reject a result whose `sha` differs; verify with action-provider tests, including a run without a contract and that no implementer message is in the prompt
- [x] 6.3 Add the `address` node (implementer follow-up with the last gate's feedback, skipped on the first visit) and the review loop `back_to: address` (max 3) in the built-in; on exhaustion park in `waiting_human`; verify with flow-run tests for fix-then-pass, rounds exhausted, and lower-only findings counting as pass
- [x] 6.4 Publish each verdict as a non-approving PR review comment and, with `statuses: write`, a `funny/review` status; add review-comment and commit-status writes to `@funny/core/github-app`; verify with tests for both installation cases
- [x] 6.5 Add `statuses: write` to the App's permission set (`APP_PERMISSIONS`; sandbox tokens stay on `SANDBOX_PERMISSIONS`) and a statuses-only server token (`issueStatusPublisher`). An installation that has not accepted it shows under Preferences > GitHub App through the existing permission-gap check (`appPermissionGaps` reads `APP_PERMISSIONS`), and each verdict records whether its status was published (`statusPublished`); the run row shows it in 7.8. Verified with the pull-request port tests for both installation cases
- [x] 6.6 Add `review` to the built-in `issue-to-merge`, with its prompt file (`triage` in both built-ins is 3.8); verify `issue-to-merge.test.ts` and `catalog.test.ts`
- [x] 6.7 Early review (design D7): when `wait_ci` starts watching a head commit, start its review if none exists for that SHA; the `review` node takes the stored verdict, waits for the review in flight or starts one; stop the thread and discard its result when the head commit changes or the run ends; `early: false` keeps the review after green checks; verify with action-provider tests for review finished before CI, CI finished first, a CI fix replacing the commit under review (stopped, not stored), `early: false`, and a server restart with an early review in flight. The free-slot rule (no early start when the review stage is full) is part of 7.7, where stage limits exist
- [ ] 6.8 Show a notice in factory settings when the `review` step resolves to the implementer's provider and model; verify with a `ProjectFactorySetting` test for same and different models

## 7. Merge one at a time

- [ ] 7.1 The factory host applies the group `merge:{{inputs.repo}}:{{inputs.base_branch}}` to every `merge` node and pins its limit to 1 (`resolveLimit`), and passes `factory_id` and `base_branch` as inputs; verify with a factory-flow test where a repository flow omits the group and two runs still merge one at a time
- [x] 7.2 Change `merge`: require a pass for the head SHA (unless `require_review: false`) and an allowed risk class, else `waiting_human` with the reason, all checked on entry after holding the slot (the verdict must be of the head commit itself, so a rewritten branch has none; "the branch still contains the last reviewed commit" is checked in 7.3, where an update-branch head is not the reviewed commit); a flow whose merge needs a review and has no review step gets a load warning; verify with tests for each refusal and the spec's MODIFIED scenarios, including a PR whose only review is an external reviewer's green check or approval (parks with "no review")
- [ ] 7.3 Without a GitHub merge queue: update-branch (merge), wait for green checks, merge only if the base did not move, else update again; no new review when only base changes came in and the branch still contains the last reviewed commit; add update-branch to `@funny/core/github-app`; verify with merge-node tests for stale-green, moved base and the review carry-over
- [ ] 7.4 With a required GitHub merge queue: detect it from the branch rules, enqueue, follow, and end the node with the failure as feedback so the merge loop goes back to `address`; verify with tests using a fake GitHub
- [ ] 7.5 Factory `priority` hook: merge waiters in admission order, a blocked-by run after its blocker; verify with an ordering test over the lease gate
- [ ] 7.6 Conflicts: end `merge` with the conflict and the in-between PR's diff as feedback, the merge loop (`back_to: address`, max 3) sends it to the implementer (specific instruction for lockfiles and numbered migrations); park when the branch no longer contains the reviewed commit; verify with tests for a conflict follow-up and a force push
- [ ] 7.7 Stage limits: `factory_settings.stage_limits` through `resolveLimit` for agent nodes (`<node>:{{inputs.factory_id}}`), not for `merge`; settings table next to the step overrides; verify with tRPC tests (merge refused) and a `ProjectFactorySetting` test
- [ ] 7.8 Show the slot a run waits for and the merge reason in the run row; verify with a `ProjectFactoryRuns` test
- [ ] 7.9 A merge failure no code change can fix (missing App permission, branch rule, GitHub error after the provider's retries) parks the run in `waiting_human` with the reason and starts no agent; verify with merge-node tests for a branch-rule refusal and a permission error, asserting no follow-up was sent
- [x] 7.10 A run waiting for the merge slot counts toward `maxConcurrent`; verify with a watcher test where two runs of a `maxConcurrent: 2` factory wait for the slot and no issue is admitted
- [ ] 7.11 Record per factory the review verdicts (pass / fail, rounds) and the reasons runs park in `waiting_human`, as metrics; verify with a test over a passed, a failed and a high-risk run

## Phase 1 exit

- [ ] 9.5 Run `bun run lint`, `bun run typecheck` and the pipelines, workflows, server, shared and client test suites; then, on a test repository with `maxConcurrent: 2`: a review failure is fixed and re-reviewed, the review of the first commit starts before its checks finish, and the second PR is updated and re-checked before merging. Deploy with `require_review: false` in the built-ins first, then flip them to the gate (design, Migration Plan)

# Phase 2: triage, path reservation and sentinel

## 3. Triage

- [ ] 3.6 Add the triage result schema (zod) to `@funny/shared/contracts/factory`; verify with schema tests for `ready`, `needs_info`, `too_big` and a missing field
- [ ] 3.7 Migration and run machine: `factory_runs` contract and likely paths, states `triaging` / `needs_info` (`needs_info` parked without a slot, `needs_info → queued`, `triaging → queued` for a path hold) as compare-and-sets, mapped in the `factory` tRPC port; verify with the migrate test, transition tests including a refused transition, and `factory-trpc` tests reading a run in each state; add them to `docs/architecture/state-machines.md`
- [ ] 3.1 Add the `triage` step kind to `packages/workflows` (schema, compiler, provider call) with only `provider` / `model` / `effort` / `prompt_file` accepted; verify with schema and compiler tests
- [ ] 3.2 Run `triage` in the factory action provider on a new read-only thread with the server-built inputs and the result reader; store the contract; verify with action-provider tests for `ready`, `needs_info`, `too_big` and invalid-twice (proceeds with no contract)
- [ ] 3.3 Post the templated issue comment (at most five items of 300 chars, mentions and links stripped); verify with tests including an `@mention` and a link in a question
- [ ] 3.4 Re-triage `needs_info` runs on the tick when the issue's `updated_at` passed the triage time, and on Retry; verify with watcher tests for an edited issue, an unchanged one, and a label not creating a second run
- [ ] 3.5 Pass the contract to the implementer's first prompt and to the reviewer in place of the issue URL, and its risk hints to the risk class; verify the launch bodies in action-provider tests and a risk test with a hint
- [ ] 3.8 Add `triage` to both built-ins, with its prompt file; verify `issue-to-merge.test.ts`, `repo-issue-to-merge.test.ts` and `catalog.test.ts`

## 4. Path reservation

- [ ] 4.1 After triage, hold a run whose likely paths intersect those of a working / fixing / reviewing / merging run of the same repository (glob intersection), releasing its slot with `wait_reason`; verify with watcher tests: overlap waits, no overlap starts, no contract never waits, the held run starts without re-triage once the other leaves those states

## 8. Sentinel

- [ ] 8.4 Add the sentinel result schema (zod) to `@funny/shared/contracts/factory` and the incident table to the migration and both schemas; verify with schema tests and the migrate test
- [ ] 8.1 Record the base branch check state after factory merges and open one incident per repository and base branch (compare-and-set) when it turns red within 24 h; pause admissions of every factory on the repository; add the incident machine to `docs/architecture/state-machines.md`; verify with watcher tests for red within and after 24 h and a second red not opening a second incident
- [ ] 8.2 Run the sentinel on a new read-only thread with the candidate merges, failing checks and logs; on a culprit open a revert PR (add revert to `@funny/core/github-app`) and notify its enabler; otherwise Web Push every affected enabler; verify with tests for both results and an invalid result escalating
- [ ] 8.3 Close the incident on green or by a member (`factory.closeIncident`, `steer`), resuming admissions; show the incident in factory settings; verify with tRPC and component tests

## 9. Docs and integration

- [ ] 9.1 Update `openwiki/architecture/issue-factory.md` (roles, invariants, loops, early review, merge group, stage limits, sentinel) and add the role names to `GLOSSARY.md`; verify the doc's file references exist
- [ ] 9.2 Run `bun run lint`, `bun run typecheck` and the pipelines, workflows, server, shared and client test suites; all pass
- [ ] 9.3 End to end on a test repository with `maxConcurrent: 2`: two issues touching the same file run one after the other, a review failure is fixed and re-reviewed, the second PR is updated and re-checked before merging, and a deliberately breaking merge opens an incident and a revert PR
- [ ] 9.4 Before archiving, merge this change's MODIFIED `merge` requirement with the text
      `factory-quality-gates` left in `openspec/specs/issue-factory/spec.md` (archived
      2026-11-22: the regression proof gate, the published `funny/regression-proof` check and
      the auto-merge pinned to the proved commit), so archiving this change does not drop
      them. Verify with `openspec validate factory-agent-roles --strict`.
