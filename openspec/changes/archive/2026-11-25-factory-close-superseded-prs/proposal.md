# Proposal

## Why

When a factory run is stopped or fails after opening its pull request, and a later run for the
same issue merges, the earlier pull request stays open. On 2026-11-25 four of them (#501, #502,
#506, #507) were open next to the merged #509–#512 and had to be closed by hand. They are noise
on the repository, and their stale branches invite someone to merge or rebase work that already
landed in another form.

## What Changes

- **When a factory run of an issue is recorded merged, the factory closes the other open pull
  requests its own earlier runs opened for that issue.** It comments "Superseded by #X" on each,
  closes it, and deletes its branch. This applies whichever way the run merged: by the factory's
  `merge` step, through its merge queue, or by a person outside the factory.
- **A pull request is left open** when its run is not ended (taken over, retried, waiting for a
  person), when its head is not a commit the factory recorded for that run (somebody pushed to
  it), or when it is not open.
- **Each close is recorded as a server activity** for the factory's enabler, with the closed and
  the merged pull request. It reuses the close a member can already ask for from the board
  (`factory.closeReplacedPr`, activity `factory.close-pr`), now with origin `system`.
- Stopping a run still leaves its pull request open, unchanged: a member may stop a run to take
  the pull request over by hand.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `issue-factory`: adds a requirement that a merged run closes its issue's superseded factory
  pull requests.

## Impact

- `packages/server/src/services/factory/`: a new `factory-superseded.ts` (which runs, which
  pull requests are left open, closing them), a `closeSuperseded` dependency of the flow runs
  called next to the merged-run worktree cleanup on all three merge paths, and an `origin` option
  on `FactoryPullRequests.closeReplaced`.
- No new GitHub operation or activity kind: `close`, `comment`, `deleteBranch` and the
  `factory.close-pr` activity already exist.
- GitHub: writes go through the repository-scoped App token capped by the enabler, as the
  factory's other pull request writes do. No new permission (pull requests: write, contents: write).
