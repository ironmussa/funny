# Design

## Context

A run reaches `merged` on three paths, and all of them already end in one place: the merged-run
worktree cleanup in `factory-watcher.ts` (`cleanupMergedFor`).

1. The run's own flow records `state: 'merged'` (`record` in `factory-flow-runs.ts`, which calls
   `cleanUpMerged` → `deps.cleanupMerged`).
2. The merge queue records a member that landed (`queueFor` → `record` in the same file).
3. A parked run whose pull request a person merged on GitHub is closed by `reconcileRun`
   (`closeParked(run.id, 'merged')`), which calls `cleanupMergedFor` itself.

Every write to GitHub goes through the App token capped by the enabler (`factory-github.ts`,
`factory-pull-requests.ts`). A member can already close a replaced run's pull request from the
board (`factory.closeReplacedPr` → `FactoryPullRequests.closeReplaced`): comment, close, delete the
branch (retargeting stacked pull requests to the base), and a `factory.close-pr` activity.

A run's branch is `factory/issue-<n>-<run id prefix>` (`factoryRunBranch`). Its pull request URL
is recorded in `prUrl` once the factory saw it. The commits the factory knows a run's pull request
had are the `sha` of its review verdicts, the `headSha` of its risk class and the `sha` of its
merge approval.

## Goals / Non-Goals

**Goals:**

- One hook, called once per run that becomes merged, whichever path merged it.
- Close only pull requests the factory is sure are its own, unchanged, and of an ended run.

**Non-Goals:**

- Closing pull requests of runs that merged before this change ships (they were closed by hand on
  2026-11-25).
- Closing a pull request when its run is stopped (see proposal: a member may take it over by hand).
- Closing pull requests that a person (not a factory run) opened for the issue.
- Undoing a close from the activities panel. A closed pull request can be reopened on GitHub, and
  the closed pull request keeps its commits, so its branch can be restored from it on GitHub.

## Decisions

### D1. A `closeSuperseded` dependency next to the merged-run cleanup

The flow runs get a `closeSuperseded(runId, repo?)` dependency, called where `cleanupMerged` is
called on each of the three paths (the flow's `cleanUpMerged`, the queue port's `record`, and
`reconcileRun`, which calls `closeSupersededFor` directly). The flow and queue paths only reach it
when their compare-and-set write returned the live row (`live.value`), and `reconcileRun` only when
`closeParked` changed the row, so it runs once per transition. It is not awaited by the flow.
Keeping it beside `cleanupMerged` instead of changing that callback's signature leaves the
existing cleanup tests and overrides as they are.

Alternative: a periodic sweep in the watcher tick that looks for merged issues with open old pull
requests. Rejected: it adds GitHub reads to every tick, and closes pull requests minutes later with
no link to the merge that caused it.

### D2. The superseded runs come from the database, not from a GitHub branch search

The candidates are the factory's runs (`runs.list(factoryId)`) with the same `issue_number`,
another id, state `stopped` or `failed` (the states `closeReplacedPr` accepts), and a recorded
`prUrl` that is not the merged run's pull request. A run with no recorded pull request is skipped:
the parked-run reconciliation records `prUrl` once it finds one, and guessing from the branch adds
a GitHub read per sibling for a case that has not happened.

Searching GitHub for every `factory/issue-<n>-*` branch would also find branches whose run row was
deleted, or that a person named the same way; neither is the factory's to close. A run without an
issue (`issueNumber === null`) supersedes nothing.

Taking a run over or retrying it moves it back to a non-terminal state (`reopen`), so a run that a
person continued is never a candidate.

### D3. Close only while the head is a commit the factory recorded

Before closing, the factory reads the pull request (`pullHead`) and requires:

- it is open (`prState === 'open'`);
- its head commit is one of the run's recorded commits (review verdict `sha`, risk `headSha`,
  regression proof `headSha`, merge approval `sha`).

A run that opened its pull request and stopped before any review or risk class records no commit:
its pull request stays open. That is the safe side; the member can still close it by hand.

Alternative: compare commit authors with the enabler's git identity. Rejected: the agent commits
with the enabler's identity, so a hand push by the enabler would look like the factory's.

### D4. The close is the member's `closeReplaced`, with origin `system`

Each candidate that passes D3 goes through `FactoryPullRequests.closeReplaced(ref, by, 'system')`,
the same call `factory.closeReplacedPr` makes: the comment naming the newer pull request, the
close, then the branch deletion with stacked pull requests moved to the base, and one
`factory.close-pr` activity for the enabler. The only addition is the `origin` argument, so the
activity says the factory did it rather than the member. Candidates are handled one after the
other; one that GitHub refuses is logged and the next one goes on.

Alternative: a new `factory.close-superseded` activity kind and a second close path. Rejected:
it would be the same GitHub writes and the same activity under another name.

## Risks / Trade-offs

- [A member wanted to keep an old pull request open after another run merged] → Only a pull request
  whose head the factory recorded is closed; one pushed to by hand stays open. It can be reopened on
  GitHub, and the activity names its branch and head so the branch can be restored.
- [A merge recorded twice (two server processes) closes twice] → The second pass finds the pull
  requests closed (`prState !== 'open'`) and does nothing.
- [The App token cannot close pull requests on a repository] → The close fails, the activity says
  so, and nothing else changes; the pull request needs closing by hand, as today.

## Migration Plan

No data migration. Ships with a server deploy; runs that merged before it are not revisited.
Rollback: revert the server change; nothing is stored that the old code would misread.
