# Design

## Context

See proposal.md. Facts from the code:

- `startPipelineRun` persists a `pipeline_runs` row and emits `pipeline:*` events from an
  `onStateChange` callback that sees every node `entering` / `completed` and the `terminal`
  outcome. The fix commit's sha is `ctx.outputs['commit-fix'].json.sha`.
- `fixNode` creates the corrector with `mode: 'worktree'`, waits, reads `git status` / `diff
  --cached` in its worktree and returns the patch; nothing cleans it. `cleanupReviewerThread`
  (the reviewer's cleanup) already goes through `cleanupWorkspace` and archives the thread.
- `restoreGitCheckpoint` reads the refs with `rev-parse --verify` and feeds them to `read-tree`,
  which accepts any tree-ish: a ref to a commit restores the same as a ref to its tree.

## Decisions

### D1. `pipeline.run`: one activity per run, from `onStateChange`

`startPipelineRun` calls `beginActivity` (kind `pipeline.run`, origin `implicit`, thread and
project of the run, input `pipelineId`, `commitSha?`) right after `createRun`. In `onStateChange`:
`entering` records the stage as a step (`Reviewing`, `Fixing`, …, from `nodeToStageType`); each new
`commit-fix` sha becomes a `commit-created` effect; `terminal` ends it `succeeded` for `completed`
(verdict in the step, "Review passed" / "Fixed in N iterations"), `failed` with "Cancelled" or the
error otherwise. A pipeline commit (`isPipelineCommit`) starts nothing, as today.

Kind metadata: `destructive: true` (it commits to the user's branch), `record: always`. No retry
target: the user did not start it, and re-running is a new commit.

### D2. Corrector cleanup

`fixNode` calls `cleanupReviewerThread(correctorThread.id, ctx.projectId)` after it has read the
diff (and on the no-changes path), the same function as the reviewer: archive the thread, remove
its worktree and branch through `cleanupWorkspace` (`review-finished`). The patch is already a
string in the context, so removing the worktree does not affect `apply-patch`. A cleanup failure is
logged, never fails the loop.

### D3. Checkpoints as dated commits, pruned at 30 days

`captureGitCheckpoint` wraps the worktree tree in a commit (`commit-tree`, no parent, the same
identity as undo snapshots) and points the `worktree` ref at it; the `index` ref stays a tree.
Restore, copy and existing refs need no change (D in Context). After each capture,
`pruneGitCheckpoints(cwd)` deletes every checkpoint whose `worktree` ref is a commit older than 30
days, with its `index` sibling. Tree-only refs (saved before this change) have no date and are
kept by the age prune.

`cleanupWorkspace` (thread archived / deleted / merged / review finished) also deletes
`refs/funny/codex-checkpoints/<threadId>/*` when it has a thread id, old or new. The refs live in
the repository, so this runs against the project checkout.

Alternative considered: prune by asking the server which threads still exist. Rejected: a data
channel round trip per capture, and the cleanup path already knows the thread is gone.

## Risks / Trade-offs

- [Rewind to a turn older than 30 days stops working] → Rewind is for recent turns; the panel
  already says checkpoints exist "from new turns".
- [Legacy checkpoints of local threads never go] → Only until their thread's workspace cleanup;
  a one-off prune can follow if needed.
