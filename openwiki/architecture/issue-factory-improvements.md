# Issue factory: possible improvements

Improvements to the issue factory ([issue-factory.md](issue-factory.md)) found while reviewing
real runs, not yet implemented. Each entry says what is missing, why it matters and a proposed
approach. Remove an entry once it ships (or turn it into an openspec change / GitHub issue).

Context: runs 201–204 (November 2026) showed two branches per run and leftover worktrees. Already
fixed: one branch per run (the worktree is created on `factory/issue-<n>-<runId8>`), cleanup of
worktrees and local branches when a run is merged (`cleanupFactoryWorktrees`), reuse of the run's
branch on a retry, and the `expectedBranch` guard on follow-ups.

## 1. Periodic sweep of orphaned worktrees

**Gap.** The merge cleanup runs once, at the moment a run becomes `merged`, and is best effort.
Worktrees are left behind when:

- the enabler's runner was offline at that moment (the warning is logged and never retried);
- the run ended `stopped` (its PR was closed without a merge) or `failed` and was abandoned;
- the thread predates the one-branch fix: its row records the empty `funny/factory-…` branch,
  so the cleanup would not delete the real `factory/issue-…` branch.

**Proposal.** On its tick, the watcher looks for finished runs whose threads still have a
`worktreePath`:

- `merged`: remove the worktree and the local branch (what `cleanupFactoryWorktrees` does);
- `stopped` / `failed` older than N days: remove the worktree only and keep the branch, since its
  commits live only there.

For legacy threads, also delete `factoryRunBranch(run)` when it differs from `thread.branch`.
Bound the sweep per tick and skip runs whose runner is offline, so it retries on a later tick.

## 2. Tell the browser about the cleanup

**Gap.** The cleanup clears `worktreePath` and `branch` on the thread row in the DB but emits no
event. An open thread view keeps pointing at the removed worktree until the page reloads.

**Proposal.** After the row update in `cleanupFactoryWorktrees`, emit `thread:updated` with
`{ worktreePath: null, branch: null }` to the thread owner through the browser event sink. Small
change.

## 3. Metrics for cleanup and the branch guard

**Gap.** Nothing counts worktree removals, failed removals, or follow-ups the runner refused
because the worktree was on another branch. A repeat of the issue 201 incident (a factory
worktree switched to another branch) would go unnoticed.

**Proposal.** Reuse the `factory.integration_event` counter with new event types
(`worktree_cleaned`, `worktree_cleanup_failed`, `branch_guard_refused`), so they show up in
Abbacchio next to the existing factory events.

## 4. Sandbox runs

**Gap.** None of the branch work applies to sandbox threads:

- the one-branch fix and branch reuse act only where the runner creates a worktree;
- the merge cleanup skips `runtime = 'sandbox'`;
- the `expectedBranch` guard only checks threads with a `worktreePath`.

How a sandbox run creates and names its branch has not been reviewed.

**Proposal.** Review the sandbox launch path (`launchSandbox` in `factory-watcher.ts`, the sandbox
runner's thread creation) and decide whether it needs the same guarantees: one branch per run,
and a branch check before follow-ups.

## 5. Factory branches in the commit graph

**Gap.** The commit graph shows a factory branch by its technical name
(`factory/issue-204-35700f7a`), which is hard to relate to its run and issue. This is what made
the two-branches problem confusing to diagnose.

**Proposal.** Recognize the `factory/issue-<n>-<runId8>` pattern in the graph's ref chips and
label it "Factory #<n>", with links to the run and its pull request.

## 6. Custom flows with the old prompt

**Gap.** A repository with its own copy of `.funny/workflows/issue-to-merge.yaml` (or
`issue-to-pr.yaml`) keeps the old instruction "Work on a new branch named `{{branch}}`". It still
works (the agent finds the branch already checked out), but the text is misleading.

**Proposal.** Document the new wording in the factory guide
([docs/guides/issue-factory.md](../../docs/guides/issue-factory.md)), or have the flow loader
warn when a custom flow still says "new branch".

## 7. Regression proof: what is still open

From `factory-quality-gates` (see [docs/guides/factory-regression-proof.md](../../docs/guides/factory-regression-proof.md)):

- **No check run yet** (task 4.4): the proof is not published as `funny/regression-proof`, so a
  repository cannot require it in a branch rule, and the factory never enables auto-merge behind
  the gate; repositories that need reviews before a merge park at `merge`.
- **The proof is held in memory**: `merge` reuses the proof the step ran in the same execution.
  After a server restart it proves the head again (slower, never weaker). Reading the stored
  `factory_runs.regression_proof` for the head SHA would skip that.
- **Load errors are recognised by their output** (`Cannot find module`, `SyntaxError`, …): an
  unrecognised one still counts as a base failure. Collect real inconclusive and false-pass cases
  before widening the patterns or adding a per-runner rule.
