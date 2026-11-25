# Tasks

## 1. Closing as the factory

- [x] 1.1 Add an `origin` argument (`'user'` default, `'system'`) to `FactoryPullRequests.closeReplaced` and its `factory.close-pr` activity, with a test
- [x] 1.2 New `factory-superseded.ts`: `supersededPullRequests` (same issue, `stopped` / `failed`, own pull request), `recordedHeads` (review, risk, proof, approval commits) and `closeSupersededPullRequests` (skip when not open or the head is not recorded; one refusal does not stop the next)
- [x] 1.3 Unit tests for the three, in `factory-superseded.test.ts`

## 2. Wiring

- [x] 2.1 `closeSupersededFor(factory, repo, runId)` in `factory-watcher-state.ts`: reads the runs and closes through the watcher's GitHub port; logs and never throws
- [x] 2.2 A `closeSuperseded(runId, repo?)` dependency of the flow runs, called beside `cleanupMerged` in the flow's `cleanUpMerged` and the queue port's `record`; wired in `factory-watcher.ts`
- [x] 2.3 `reconcileRun` calls `closeSupersededFor` once a person's merge is recorded
- [x] 2.4 Watcher test: a parked run merged outside the factory closes a stopped sibling's pull request and leaves a pushed-to one open

## 3. Docs and verification

- [x] 3.1 Document it in `openwiki/architecture/issue-factory.md`
- [x] 3.2 Run `bun run lint`, `bun run typecheck` and the factory test suites
- [ ] 3.3 (deferred, not run at archive time) E2E on test-funny: stop a run after its pull request opens, send the issue again, let the new run merge, and check the old pull request is closed with the comment and a `factory.close-pr` activity of origin `system`
