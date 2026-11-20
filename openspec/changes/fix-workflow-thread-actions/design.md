# Design

## Context

`RuntimeActionProvider` (`packages/runtime/src/services/pipeline-adapter.ts`) is the
runtime's implementation of the workflow actions. `spawnAgent` starts its child
thread without the parent's `worktreePath`, so the child runs in the project
directory. `createPr` passes only title and body to `git-service`, and `createPR` in
`@funny/core` has no draft flag. The dispatch route resolves the thread's directory
as `worktreePath ?? project.path`, which is silently wrong for an idle worktree thread.

## Goals / Non-Goals

**Goals:**

- A workflow's agent steps edit the same checkout the thread owns.
- `create_pr` options in YAML reach `gh pr create`.

**Non-Goals:**

- New workflow actions or a new YAML schema version.
- Changing how normal (non-workflow) threads pick their directory.

## Decisions

### 1. The child of `spawnAgent` inherits the parent's workspace

Pass the parent's `worktreePath` and branch to `createAndStartThread`. A missing
worktree is an error, not a fallback, because running in the main checkout can mix an
agent's edits into the user's working copy.

_Alternative: let `spawnAgent` run the agent in-process in the parent thread._
Rejected: it would change how steps appear in the UI and how they are stopped.

### 2. `create_pr` defaults stay backward compatible

Without `base`, use the thread's base branch (today's behavior through `gh`'s default
is the repository default branch, which is wrong for worktrees off another branch).
Without `draft`, open a regular pull request, as today.

### 3. Dispatch sets up the worktree

For a worktree thread without `worktreePath`, the dispatch route runs the same
worktree setup as thread start (`thread-service/create.ts`) before the workflow, and
answers an error if it fails.

## Risks / Trade-offs

- [Workflows that relied on the main checkout] → None of the bundled workflows do;
  the change notes it for repositories that override them.
- [Default base now differs from `gh`'s default for some threads] → It now matches the
  branch the worktree was created from, which is what the pull request should target.
