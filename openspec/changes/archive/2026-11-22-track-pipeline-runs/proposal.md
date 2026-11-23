# Proposal

## Why

Two loose ends of `track-funny-actions` and `track-user-and-scheduled-actions`:

- **Review pipeline runs leave no activity.** A commit can trigger the project's code-review
  pipeline (`pipeline-manager.ts` `startPipelineRun`, from `pipeline-trigger-handler.ts`). It
  starts review and fix agents and commits their fixes to the user's branch, and the Activity
  panel shows nothing of it; only the pipeline's own run row and a thread event exist.
- **A corrector's worktree is never removed.** In the git workflow's review-fix loop
  (`git-pipelines/review-fix.ts` `fixNode`), each iteration starts a corrector agent in its own
  worktree, reads its diff and leaves the worktree and branch behind. The reviewer is cleaned up;
  the corrector is not.
- **Rewind checkpoints are never pruned.** `git-checkpoints.ts` saves the working tree under
  `refs/funny/codex-checkpoints/<thread>/<message>/…` before every agent turn and never removes
  it. Undo snapshots are pruned after 30 days; checkpoints grow forever, including those of
  deleted threads.

## What Changes

- A review pipeline run is one `pipeline.run` activity (origin `implicit`, it follows from a
  commit): a step per pipeline stage, the fix commits it made as `commit-created` effects, the
  verdict in its outcome, `failed` when it is cancelled or errors.
- The review-fix loop removes the corrector's worktree and branch through the workspace module
  (reason `review-finished`) once its diff is read, as it already does for the reviewer.
- Checkpoints are stored as commits (their trees as before), so they carry a date, and those older
  than 30 days are pruned whenever a new one is saved. Cleaning up a thread's workspace also
  removes that thread's checkpoints. Checkpoints saved before this change have no date; they are
  removed with their thread's workspace and otherwise kept.

## Capabilities

### Modified Capabilities

- `background-activities`: review pipeline runs are tracked operations.
- `thread-workspace-cleanup`: a corrector's worktree is removed; a thread's cleanup removes its
  checkpoints.
- `git-undo-snapshots`: rewind checkpoints are pruned like undo snapshots.

## Impact

- Shared: kind `pipeline.run`, effect `commit-created`.
- Runner: `pipeline-manager.ts` (activity), `git-pipelines/review-fix.ts` (corrector cleanup),
  `git-checkpoints.ts` (commit-wrapped checkpoints, prune), `workspace-cleanup.ts` (thread
  checkpoint removal).
- Client: the effect label (en, es, pt). No server or database change.
