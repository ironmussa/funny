# Tasks

## 1. Shared

- [x] 1.1 Add the kind `pipeline.run` (input `pipelineId`, `commitSha?`; destructive, record always) and the effect `commit-created`; verify `activity-kinds.test.ts` covers the input

## 2. Runner

- [x] 2.1 Record each review pipeline run as a `pipeline.run` activity from `startPipelineRun` (design D1); verify tests cover a completed run with a fix commit, a cancelled run and a pipeline commit that records nothing
- [x] 2.2 Remove the corrector's worktree in `fixNode` through `cleanupReviewerThread` on both paths (design D2); verify `pipeline-orchestration` / review-fix tests show the cleanup and that the patch is still applied
- [x] 2.3 Store checkpoints as commits and prune those older than 30 days after each capture (design D3); verify `git-checkpoints.test.ts` covers restore of a new and a legacy checkpoint, a 31-day-old checkpoint pruned and a legacy one kept
- [x] 2.4 Remove a thread's checkpoint refs in `cleanupWorkspace`; verify `workspace-cleanup.test.ts` covers it

## 3. Client and integration

- [x] 3.1 Add the `commit-created` effect label (en, es, pt)
- [x] 3.2 Update `openwiki/architecture/background-activities.md`; run `bun run lint`, `bun run typecheck` and each affected package's `test` script; verify all pass
