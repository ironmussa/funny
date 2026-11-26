# Proposal

## Why

A factory merges every run into one branch (its "Merge into", else the repository's default
branch). Two large features developed through the factory at the same time therefore land on the
same branch while they are half done, and the only way to keep them apart today is to work on them
one after the other, or to add the repository twice as two projects. A team needs one factory to
develop several features in parallel, each on its own branch, without those branches drifting so
far from the base that the final merge hurts.

## What Changes

- A factory gets **lanes**, named by a label on the issue with a standard form: `lane:<name>`
  runs on the branch `feature/<name>` (both prefixes are factory settings). Nobody registers a
  lane: the factory creates it, and its branch, when it first admits an issue that names it. An
  issue with no lane label runs on the factory's "Merge into" branch as today; an issue with two
  lane labels is not admitted and shows why.
- The base branch is decided **once per run, at admission**, and stored on the run
  (`factory_runs.base_branch`). Every use of the base (worktree start, triage and review
  checkouts, `integrate`, `create_pr`'s retarget, stacking, the merge lane and the merge queue,
  the "no change" check) reads the run's base instead of the factory's. A label changed later,
  or a retry, does not move a run to another branch.
- **Lane sync**: the factory brings its "Merge into" branch into each lane branch whenever that
  branch moved (whoever moved it), at most once an hour per lane, through a pull request into the
  lane branch merged with a merge commit (never squash). A sync without a conflict needs no agent
  and no runner. A conflict, or red checks, goes to one agent; after three attempts the lane waits
  for a person.
- A run whose blocker merges into **another branch** is not stacked on it and waits as
  `blocker-on-other-branch` until the blocker's merge is in its own base, so one feature's work
  never reaches the other's branch.
- A lane run's issue is **closed by the factory** when the run merges into the lane (GitHub's
  `Closes #N` only acts on the default branch), with a comment naming the branch.
- **Finishing a lane**: the factory opens the lane → "Merge into" pull request, a person merges
  it, and the factory then marks the lane finished (later issues with its label run on "Merge into").
- Flows and prompt files are still read from the repository's default branch.
- Later phases (in this change's tasks, not required for the first release): the red-base
  sentinel pauses only the runs on the red branch; a lane filter on the board; a dry-run merge
  between lane branches that warns early when two features conflict.
- Not in this change: lanes chosen by milestone, a lane based on another lane, and a concurrency
  limit per lane (lanes share the factory's limits).

## Capabilities

### New Capabilities

- `factory-lanes`: lanes of a factory (the `lane:<name>` label convention), how a run gets its base branch, lane sync,
  cross-lane dependencies, and the later-phase lane features (cross-lane
  conflict warning, final lane pull request).

### Modified Capabilities

- `issue-factory`: "A factory may merge into a branch other than the default" now applies to runs
  without a lane, and the branch a run uses is the one recorded on the run at admission;
  "Dependent issues can be stacked" no longer stacks across lanes; "A red base branch after a
  factory merge opens an incident" pauses only the runs on the red branch.

## Impact

- **DB**: `factory_runs.base_branch` (nullable for runs admitted before the change: they keep
  reading the factory's branch) and `factory_runs.merge_sha`; a `factory_lanes` table (factory,
  name, branch, state, sync state, finish pull request) and the two prefixes on `factory_settings`.
- **Server**: `services/factory/` — admission (`factory-watcher.ts`, `factory-queue.ts`), the repo
  reads' `defaultBranch()` / `mergeTarget()` (`factory-repo-reads.ts`, `factory-github.ts`), the
  action provider's `worktreeBase()`, `factory-integrate.ts`, `factory-stacking.ts`,
  `factory-flow-runs.ts` (lane name), `factory-dependencies.ts`, `factory-settings.ts`; a new
  lane-sync service with its own state on the lane row (not a flow run).
- **API**: the `factory` tRPC group (lane prefixes, lane list, remove, sync and finish; base branch on the run view); `@funny/shared/contracts/factory`.
- **Client**: Settings > project > Factory (lane prefixes, lanes list), run card (base branch; lane chip later).
- **GitHub**: lane branches need CI triggered for pull requests that target them (and for pushes,
  for the sentinel); the settings warn when it is not. This repository's own workflows filter on
  `branches: [master]` and need the lane pattern added. The repository must allow merge commits.
