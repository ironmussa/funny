# Proposal

## Why

Two workflow actions in funny's runtime do not do what a workflow asks. An agent step
of a workflow running for a worktree thread works in the project's main checkout
instead of the thread's worktree, and `create_pr` drops the `base` and `draft` options.
A dispatched workflow for a worktree thread that has not started yet also falls back
to the project path without saying so. Any workflow that edits code in a worktree and
opens a pull request is affected; the issue factory surfaced them, but it no longer
depends on them (ADR 0001), so they are fixed on their own.

## What Changes

- Agent steps run in the thread's workspace (its worktree for a worktree thread) and
  fail, instead of falling back, when that worktree is missing.
- `create_pr` honors `base` and `draft`, defaulting to the thread's base branch and a
  regular pull request, and gives later steps the pull request URL.
- The runner's workflow dispatch sets up the worktree of a worktree thread that has
  none yet, and fails instead of using the project path when it cannot.

## Capabilities

### New Capabilities

- `workflow-thread-actions`: which workspace a workflow's agent steps use, and which
  options the pull request action honors.

### Modified Capabilities

None.

## Impact

- `packages/core/src/git/remote.ts` (`createPR` gains `draft`), the runtime's
  `git-service` and `services/pipeline-adapter.ts` (`RuntimeActionProvider`).
- `packages/workflows` (YAML compiler and schema for `create_pr.base` / `draft`).
- The runner's `POST /api/scheduler/dispatch` route.
- No API, database or client change.
