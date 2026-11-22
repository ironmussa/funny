# Tasks

Prerequisites: `workflow-dag-engine` groups 1–3 (executor, loops, concurrency groups, journal) and `factory-flow-step-options` groups 1–3 (per-step options and `thread: new`).

## 1. Structured role results

- [ ] 1.1 Add the triage, review and sentinel result schemas (zod) to `@funny/shared/contracts/factory`, with the review result carrying `sha` and findings with severity; verify with schema tests for valid, missing-field and wrong-severity results
- [ ] 1.2 Add a server reader that takes a thread's final message, extracts the last fenced `json` block and validates it against a role schema, with one re-emit follow-up on failure; verify with unit tests for no block, two blocks (last wins), invalid then valid, invalid twice
- [ ] 1.3 Document the result contract in `openwiki/architecture/issue-factory.md`; verify the doc's file references exist

## 2. Run states and storage

- [ ] 2.1 Migration in `server/src/db/migrate.ts` and both schemas: `factory_runs` contract, likely paths, verdicts (per SHA), risk class, new states `triaging` / `needs_info` / `reviewing` / `merging`; `factory_settings.auto_merge`, `sensitive_paths` and `stage_limits`; verify with the migrate test and `bun run db:push` on a scratch DB
- [ ] 2.2 Extend the run machine in `factory-runs.ts` (`needs_info` parked without a slot, `needs_info → queued`, `triaging → queued` for a path hold) as compare-and-sets; verify with transition tests including a refused transition from a wrong state
- [ ] 2.3 Map the new states and fields in the `factory` tRPC port and `@funny/shared/contracts/factory`; verify with `factory-trpc` tests reading a run in each new state
- [ ] 2.4 Add the run machine changes to `docs/architecture/state-machines.md`

## 3. Triage

- [ ] 3.1 Add the `triage` step kind to `packages/workflows` (schema, compiler, provider call) with only `provider` / `model` / `effort` / `prompt_file` accepted; verify with schema and compiler tests
- [ ] 3.2 Run `triage` in the factory action provider on a new read-only thread with the server-built inputs and the result reader; store the contract; verify with action-provider tests for `ready`, `needs_info`, `too_big` and invalid-twice (proceeds with no contract)
- [ ] 3.3 Post the templated issue comment (at most five items of 300 chars, mentions and links stripped); verify with tests including an `@mention` and a link in a question
- [ ] 3.4 Re-triage `needs_info` runs on the tick when the issue's `updated_at` passed the triage time, and on Retry; verify with watcher tests for an edited issue, an unchanged one, and a label not creating a second run
- [ ] 3.5 Pass the contract to the implementer's first prompt; verify the launch body in an action-provider test

## 4. Path reservation

- [ ] 4.1 After triage, hold a run whose likely paths intersect those of a working / fixing / reviewing / merging run of the same repository (glob intersection), releasing its slot with `wait_reason`; verify with watcher tests: overlap waits, no overlap starts, no contract never waits, the held run starts without re-triage once the other leaves those states

## 5. Test-weakening check and risk class

- [ ] 5.1 Add the test-weakening check over a pull request's file list and patch (removed tests, skip / focus markers for TS/JS and Python, coverage thresholds, `.github/workflows/`); verify with fixture-diff unit tests for each finding and a clean diff
- [ ] 5.2 Add the risk classifier (findings, > 400 changed lines, default and configured sensitive paths, contract risk hints); verify with unit tests per rule and that a review result cannot change it
- [ ] 5.3 Add pull request file list / patch reads to `@funny/core/github-app` if missing; verify with its tests

## 6. Review gate

- [ ] 6.1 Add the `review` step kind and refuse write permission modes on it at load; verify with schema tests and a factory-flow load test naming step and field
- [ ] 6.2 Run `review` on a new read-only thread per head SHA with the contract, the commit, the PR body, the test-weakening report and the factory's recent / in-flight PRs; reject a result whose `sha` differs; verify with action-provider tests, including that no implementer message is in the prompt
- [ ] 6.3 Add the `address` node (implementer follow-up with the last gate's feedback, skipped on the first visit) and the review loop `back_to: address` (max 3) in the built-in; on exhaustion park in `waiting_human`; verify with flow-run tests for fix-then-pass, rounds exhausted, and lower-only findings counting as pass
- [ ] 6.4 Publish each verdict as a non-approving PR review comment and, with `statuses: write`, a `funny/review` status; add review-comment and commit-status writes to `@funny/core/github-app`; verify with tests for both installation cases
- [ ] 6.5 Give the App manifest its own permission set with `statuses: write` (sandbox tokens unchanged) and show the accept-permission notice in factory settings; verify with a manifest test and a `ProjectFactorySetting` test
- [ ] 6.6 Add `review` to the built-in `issue-to-merge` and `triage` to both built-ins, with prompt files; verify `issue-to-merge.test.ts` and `catalog.test.ts`

## 7. Merge one at a time

- [ ] 7.1 The factory host applies the group `merge:{{inputs.repo}}:{{inputs.base_branch}}` to every `merge` node and pins its limit to 1 (`resolveLimit`), and passes `factory_id` and `base_branch` as inputs; verify with a factory-flow test where a repository flow omits the group and two runs still merge one at a time
- [ ] 7.2 Change `merge`: require a pass for the head SHA (unless `require_review: false`) and an allowed risk class, else `waiting_human` with the reason; and that the branch still contains the last reviewed commit, all checked on entry after holding the slot; verify with tests for each refusal and the spec's MODIFIED scenarios, including a PR whose only review is an external reviewer's green check or approval (parks with "no review")
- [ ] 7.3 Without a GitHub merge queue: update-branch (merge), wait for green checks, merge only if the base did not move, else update again; no new review when only base changes came in; add update-branch to `@funny/core/github-app`; verify with merge-node tests for stale-green, moved base and the review carry-over
- [ ] 7.4 With a required GitHub merge queue: detect it from the branch rules, enqueue, follow, and end the node with the failure as feedback so the merge loop goes back to `address`; verify with tests using a fake GitHub
- [ ] 7.5 Factory `priority` hook: merge waiters in admission order, a blocked-by run after its blocker; verify with an ordering test over the lease gate
- [ ] 7.6 Conflicts: end `merge` with the conflict and the in-between PR's diff as feedback, the merge loop (`back_to: address`, max 3) sends it to the implementer (specific instruction for lockfiles and numbered migrations); park when the branch no longer contains the reviewed commit; verify with tests for a conflict follow-up and a force push
- [ ] 7.7 Stage limits: `factory_settings.stage_limits` through `resolveLimit` for agent nodes (`<node>:{{inputs.factory_id}}`), not for `merge`; settings table next to the step overrides; verify with tRPC tests (merge refused) and a `ProjectFactorySetting` test
- [ ] 7.8 Show the slot a run waits for and the merge reason in the run row; verify with a `ProjectFactoryRuns` test

## 8. Sentinel

- [ ] 8.1 Record the base branch check state after factory merges and open one incident per repository and base branch (compare-and-set) when it turns red within 24 h; pause admissions of every factory on the repository; add the incident machine to `docs/architecture/state-machines.md`; verify with watcher tests for red within and after 24 h and a second red not opening a second incident
- [ ] 8.2 Run the sentinel on a new read-only thread with the candidate merges, failing checks and logs; on a culprit open a revert PR (add revert to `@funny/core/github-app`) and notify its enabler; otherwise Web Push every affected enabler; verify with tests for both results and an invalid result escalating
- [ ] 8.3 Close the incident on green or by a member (`factory.closeIncident`, `steer`), resuming admissions; show the incident in factory settings; verify with tRPC and component tests

## 9. Docs and integration

- [ ] 9.1 Update `openwiki/architecture/issue-factory.md` (roles, invariants, loops, merge group, stage limits, sentinel) and add the role names to `GLOSSARY.md`; verify the doc's file references exist
- [ ] 9.2 Run `bun run lint`, `bun run typecheck` and the pipelines, workflows, server, shared and client test suites; all pass
- [ ] 9.3 End to end on a test repository with `maxConcurrent: 2`: two issues touching the same file run one after the other, a review failure is fixed and re-reviewed, the second PR is updated and re-checked before merging, and a deliberately breaking merge opens an incident and a revert PR
