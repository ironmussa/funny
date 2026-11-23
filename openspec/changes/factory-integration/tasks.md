# Tasks

Prerequisites: `workflow-dag-engine` groups 1–3 including batch groups (its tasks 1.7 and 3.4), and
`factory-agent-roles` groups 6–7 (review gate, `merge` node, `address` loop).

**Phases (2026-11-23).** Both prerequisites are archived. The change ships in two phases:

- **Phase 1, conflicts resolved without an agent:** group 2 (`run_command`), group 3 (`integrate`,
  regenerators, loop budget, review freshness; not 3.5), 6.2 for the integrate counters
  (`integrateRounds`, `conflictsResolvedWithoutLlm`, `conflictsSentToAgent`), 6.3 for what phase 1
  ships, 7.1, and the parts of 7.2 that do not need the queue (adjacent imports merge without the
  implementer, a lockfile conflict is regenerated). The serial merge lane of `factory-agent-roles`
  stays the merge path.
- **Phase 2, the batched queue:** group 1 (integration provider), group 4 (queue, bisection),
  3.5 (`regenerate:` on `merge`, a loop back to an arbitrary node),
  group 5 (early integration, stacking), 6.1 (readiness), the queue counters of 6.2, and the rest
  of 7.2.

## 1. Integration provider

- [x] 1.1 Add `IntegrationProvider` to `@funny/core` (`branchRules`, `createBranch`, `mergeRefInto`, `mergePullRequest`, `checks`, `deleteBranch`, `enqueueInHostQueue`, `pullRequestMergeability`) returning `ResultAsync`; verify with unit tests over a fake
- [x] 1.2 GitHub implementation over the App token (rulesets and the GraphQL merge queue field for "merge queue required", never an endpoint that needs the administration permission; the merges API for `mergeRefInto` with a commit message; a tree-identical commit through the git data API); verify with tests against recorded GitHub responses, including a conflict answer and a required-merge-queue ruleset

## 2. Commands in factory flows

- [x] 2.1 Allow `run_command` in factory flows: executed by the runner in the run's worktree or sandbox (never on the server), default timeout 10 min, per-step `timeout`, bounded stdout/stderr recorded on the run, non-zero exit fails the step; verify with action-provider and runtime tests for success, failure, timeout kill and the refusal of a server-side execution path
- [x] 2.1b Mask the values of the secrets the runner put in a `run_command` step's environment (App installation token, provider keys) in its recorded output, keeping the last 64 KiB of each stream; verify with a runtime test that runs `env`
- [x] 2.2 Validate `run_command` in factory flow loading (only from the default branch, as flows are today) and show it in Validate flow; verify with factory-flow load tests

## 3. Integrate step and regenerators

- [x] 3.1 Carry weave, the attributes file and `rerere` in the environment of a factory run's processes (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, `core.attributesFile` on a funny-owned file) for `integrate` and agent steps, writing nothing to the repository; verify with a core test on a temp repo with a linked worktree (driver used, `.git/config` and `info/attributes` of the main checkout unchanged) and a runtime test for the sandbox
- [x] 3.2 Implement the `integrate` operation (merge base in, never rebase; regenerators; integration checks; commit; push; abort with conflicted paths and the in-between PR's diff on remaining conflicts); report the resolved hunks and regenerated paths; verify with temp-repo tests for: adjacent additions resolved by the driver, a lockfile regenerated, a real conflict aborted with feedback
- [x] 3.3 Parse and validate `.funny/integrate.yaml` from the default branch with the flow; report problems in Validate flow; verify with loader tests for a valid file, an invalid glob and a missing command
- [x] 3.4 Add the `integrate` node to the built-in flow as the start of both loop regions (`back_to: integrate`), skipped when the branch contains the base, with `address` skipped when no gate left feedback; verify with a flow-run test where a resolvable conflict never reaches the implementer and a real one does
- [x] 3.4c Loop budget: merge loop `max_iterations` 10 in the built-in, and the factory parks a run after 2 rounds that reached the implementer; verify with flow-run tests for four resolved rounds (not parked) and three agent rounds (parked)
- [x] 3.4b Review freshness after `integrate`: a clean merge of the base keeps the review; a resolved conflict sends the run through the review gate again with the reviewer limited to the resolved hunks and regenerated paths; verify with flow-run tests for both cases
- [ ] 3.5 `regenerate: <node>` on `merge`: a conflict re-runs that node on the new base through the merge loop; verify with a flow-run test for a codemod run

## 4. Merge queue

- [x] 4.1 Batch rows (members, base SHA, branch, attempt, state) and bisection attempt rows with compare-and-set writers; add the machine to `docs/architecture/state-machines.md`; verify with migration and transition tests
- [ ] 4.2 Batch leader: re-verify members, build the batch on `factory/staging/<batchId>` with `mergeRefInto` (App token capped by the leader's enabler) and point `factory/queue/<batchId>` at the result, drop a member that does not merge (to `integrate`), wait for checks, base check, merge in order with each run's enabler-capped token, verify the resulting tree, delete the branch; staging merge commits carry `[skip ci]` and the queue branch gets a tree-identical commit; the batch verdict requires the expected checks (no checks is never green); each merge call carries the member's recorded head SHA; verify with queue tests over a fake provider: green batch with one CI run, base moved, member conflict, tree mismatch escalates, members of two enablers each merged with their own token, no checks reported, a member's head moved, a member stopped, the leader stopped, a merge refused after the first landed (partial landing recorded, the rest requeued)
- [ ] 4.3 Red batch: one more test of the same tree first, on a tree-identical commit (green → flake, merge); then bisection in parallel halves from the same base, splitting every red half, culprits to `address`, the rest settled as requeued and tested again as a new batch before merging, no red half → batches of one; verify with tests for a culprit at each position, two culprits, a flake, an interaction failure and a batch of one
- [ ] 4.4 Delegate to GitHub's merge queue when the rules require it, read per batch; verify with a test that switches when the rule appears
- [ ] 4.4b Branches that require being up to date (`strict` checks): batches of one on them, never a bypass; when the rule cannot be read, learn it from the refused second merge and remember it per branch; verify with a provider-response test and queue tests for both paths
- [ ] 4.5 Queue order (blockers first, much smaller changes first, disjoint batches, regenerable runs alone) through the engine's `priority` and batch selection; verify with ordering tests
- [ ] 4.6 Factory setting for batch size and wait (defaults 5 and 60 s) next to the stage limits; verify with tRPC and component tests

## 5. Early integration and stacking

- [ ] 5.1 On a merge into a repository, check mergeability of overlapping in-flight runs (read only) and run `integrate` on those that no longer merge, rate-limited per run; outside the flow, under a per-run workspace lock that agent steps and commands also hold (`integration_pending_at` column while a step is active; a run in `ci` is followed by `wait_ci` on the new head; a run in `review` keeps or loses its verdict by the freshness rule; a run waiting for or holding the merge slot is left to the queue); verify with watcher tests for overlap, no overlap, the rate limit, an active implementer, a run in `ci` and a run in `review`
- [ ] 5.2 `factory_settings.dependencies` (`wait` default, `stack`): a stacked run starts on its blocker's branch with its PR against it, merges after it, parks when the blocker fails or its PR is closed; a push to the blocker's branch integrates it into the stacked runs; a stacked run is never batched with its blocker and enters the queue only after the server retargeted its PR and `integrate` brought the base in; verify with admission and queue tests, and a temp-repo test where the blocker is squash-merged after a late fix and the stacked branch merges the base without a conflict

## 6. Readiness and metrics

- [ ] 6.1 Readiness check per repository (CI on `factory/queue/**`, merge driver on the runner, median CI vs batch wait, required GitHub merge queue, required up-to-date branches); block batches with the reason when CI does not run on the queue branches; offer a factory run that opens the PR adding the trigger; verify with port and component tests
- [ ] 6.2 Extend `factory_runs.metrics` with `integrateRounds`, `conflictsResolvedWithoutLlm`, `conflictsSentToAgent`, `queueWaitMs`, `batchSize`, `bisectionRounds`, `ciFlakes` (missing read as 0) and the 30-day summary; extend `factory.integration_event`; verify with action-provider, queue and `factory-metrics` tests
- [ ] 6.3 Update `openwiki/architecture/issue-factory.md` (queue, integrate, regenerators, run_command limits, stacking, readiness, metrics); verify its file references exist

## 7. Integration

- [ ] 7.1 Run `bun run lint`, `bun run typecheck` and the core, runtime, server, workflows and client suites; all pass
- [ ] 7.2 End to end on a test repository with CI on `factory/queue/**`: three issues merge as one green batch; a batch with one breaking change is bisected and the others merge after a green re-batch; two runs adding adjacent imports merge without the implementer; a lockfile conflict is regenerated
