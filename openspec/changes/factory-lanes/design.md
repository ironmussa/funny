# Design

## Context

See proposal.md for the motivation and specs/ for the behavior.

Today the base branch of every run comes from one place. `factory-github.ts` builds the repo reads
per call with `() => factoryBaseBranchOf(reader.ownerId, reader.projectId)`, and
`createFactoryRepoReads`' `mergeTarget()` / `defaultBranch()` answers that branch (else the
repository's default branch). Every consumer asks it: the worktree start (`worktreeBase()` in
`factory-action-provider/threads.ts`, also used by triage and review), `factory-integrate.ts`,
`factory-stacking.ts`, `create_pr`'s `retargetIfMisdirected`, `branchAhead`, the merge lane name
(`factory-flow-runs.ts`, `merge:{{inputs.repo}}:{{inputs.base_branch}}`), the queue's flow checks
(`factory-queue-flows.ts`), the watcher (`factory-watcher.ts:527`) and the sentinel.

What is already keyed by base branch, and needs no change: the merge lane group, the merge-queue
batches (`factory_batches.base_branch`), the batch leader, and the incidents
(`factory_incidents`, one per repository and base branch). The run row has no base branch, and no
merge commit.

## Goals / Non-Goals

**Goals:**

- One seam decides a run's base. Consumers keep calling `defaultBranch()` and get the run's
  branch, so no consumer re-derives the lane rule.
- A run never changes base after admission.
- Lane branches stay close to the factory's base without a person doing it.

**Non-Goals:**

- Several factories per project and user. Lanes live inside the one factory.
- Lanes in other repositories, or lanes based on another lane (a lane's base is always the
  factory's "Merge into" branch).
- Lanes chosen by milestone, and a concurrency limit per lane. Lanes share the factory's limits.
- A run without an issue that merges. `merge`, `review` and `triage` refuse a run with no issue
  (`needsIssue` in `factory-action-provider.ts`), and this change keeps that.
- Reading flows or prompts from a lane branch.
- Merging a finished lane automatically.

## Decisions

### D1. A lane is a label convention, and the factory label still admits

A lane is named on the issue: a label `<lane prefix><name>` (default `lane:` since D11, `feature:` before), matched without
regard to case, selects the lane `<name>`, whose branch is `<branch prefix><name>` (default
`lane/`, `feature/` before). The two prefixes are columns of `factory_settings`, changeable only while the factory
has no lane. A feature is one label the team creates in GitHub, with nothing to register in funny.
_Alternative:_ a table of label → branch filled in by hand (the first draft). Rejected: a lane is
per feature and short-lived, so each one would need a settings visit before its first issue.

The factory's own label (`ready-for-agent`) and the manual queue still decide WHETHER an issue is
admitted. The lane label only decides WHERE it runs, so an issue in automatic mode needs both.
_Alternative:_ a lane label also admits. Rejected: it creates a second admission path to keep
consistent with the queue, pause and stop-all.

The lane row is created at admission, in the same step that resolves the run's base (D2): insert
into `factory_lanes` (`factory_id`, `name` lower-cased, `branch`, `state` `active` | `finished`,
`created_at`, the sync fields of D4, `finish_pr_number`), unique on `(factory_id, name)`, ignoring
a row that exists. A missing branch is created from the head of the "Merge into" branch with the
App token (the git refs API), as the enabler. The name goes through `factoryBaseBranchSchema` as
part of the branch; a name that fails, or a branch that cannot be created, keeps the issue queued
with `lane-invalid` and the reason. The branch may not be the "Merge into" or the default branch.

Anyone who can label an issue can name a new lane, but only an admitted issue creates one, and
admission is the enabler's (their label or their queue). A typo makes a visible lane with one run,
which the member removes when that run ends.

A finished lane's row stays (`state = finished`) until a member removes it. While it stays, its
name routes to "Merge into", so a late fix does not reopen a merged branch. Removal is refused
while a run with that base or the lane's sync is in flight. Changing the factory's "Merge into"
branch is refused while the factory has lanes, because every lane was cut from it and syncs from it.

When a lane is created, the factory reads the workflows' `pull_request` and `push` branch filters
(as the merge-queue readiness check reads the repository's rules) and stores a warning on the lane
when they exclude its branch. It does not refuse: a repository may run its checks elsewhere.

### D2. The base is frozen on the run at admission

Add `factory_runs.base_branch` (nullable). The admission compare-and-set that creates or admits a
run writes it in the same statement. The lane is resolved from the issue's labels as the watcher
or the queue read them for that admission. Two matching lanes make the issue not admitted, with
the wait reason `lane-ambiguous`. A missing value (runs from before the change) means "the
factory's setting", read as today. A retry or resume never recomputes it.
_Alternative:_ resolve the lane from the issue's labels on each step. Rejected: a label edit would
move a pull request between branches in the middle of a run.

### D3. The reader carries the run's base

`FactoryRepoReader` gets an optional `baseBranch`. `reads(reader)` passes
`() => reader.baseBranch ?? factoryBaseBranchOf(...)` to `createFactoryRepoReads`. The action
provider and `factory-flow-runs.ts` build their reader from the run, so `defaultBranch()`,
`worktreeBase()`, `branchAhead`, integrate, stacking and the retarget all follow without changes at
the call sites. Factory-level callers that have no run (the queue's flow checks, the watcher's
admission, the sentinel) keep the factory's branch, or iterate the bases explicitly (D6).
_Alternative:_ pass the base to each consumer. Rejected: eight call sites, each one a place to
forget it.

### D4. Lane sync is its own small state machine, not a flow run

The first draft made a sync a run of a built-in flow with no issue. That does not hold: `merge`
and `review` refuse a run without an issue, `integrate` needs a run checkout on a runner, and the
review and risk gates would judge the whole base's diff as the sync's change. A sync is also much
simpler than a run when nothing conflicts. So `factory-lane-sync.ts` owns it, with its state on the
lane row and compare-and-set transitions (docs/architecture/state-machines.md):

```
idle ──start──▶ merging ──clean──▶ checking ──green + merged──▶ idle
                   │                  │  ▲
                conflict             red │ pushed
                   ▼                  ▼  │
                resolving ◀───────────┘  │      (attempts ≤ 3)
                   └─────────────────────┘
resolving / checking ──attempts used up, or a refusal──▶ needs_human ──retry──▶ merging
```

Columns: `sync_state`, `sync_base_sha` (the base head being brought in), `sync_pr_number`,
`sync_thread_id`, `sync_attempts`, `sync_started_at`, `sync_error`, `last_synced_base_sha`.

- **start** (watcher tick, or the member's "Sync now"): state `idle`, the base head differs from
  `last_synced_base_sha`, the lane does not contain it (compare API), and `sync_started_at` is more
  than an hour old (the hour is skipped for "Sync now"). One trigger covers factory merges and
  people's merges into the base, and the hour keeps a busy base from re-running the checks of every
  open lane pull request on each commit.
- **merging**: the server creates `factory/sync/<lane name>` from the lane's head and calls
  GitHub's merge API (`POST /repos/{repo}/merges`, base = the sync branch, head = the base sha).
  It writes a merge commit on the sync branch, never on the lane's branch. 201 → open the pull
  request into the lane, `checking`. 409 → `resolving`. No runner is involved.
- **resolving**: one thread on the enabler's runtime (`startThreadOnRunner`, worktree on the sync
  branch) with a built-in prompt: merge `origin/<base>`, settle the conflicts, run the checks,
  push. A later attempt is a follow-up on the same thread with the failing checks. When the thread
  ends, the server verifies that the sync branch contains `sync_base_sha` before going on; an
  agent that did not push, or pushed something else, uses up an attempt.
- **checking**: the checks of the pull request's head, read with `createPullRequestCi` as `wait_ci`
  does. Green → merge with the `merge` method (`mergePinned(pr, sha, 'merge')`) while holding the
  concurrency group `merge:<repo>:<lane branch>`, the one the lane's runs merge under, so a sync
  and a run never merge into the lane at the same time. Red → `resolving`.
- **needs_human**: three attempts used up, the repository refuses merge commits (405), or the
  enabler lost access. The lane shows `sync_error` and the pull request. A member's retry goes back
  to `merging`. No other sync of the lane starts meanwhile.

A sync is resumed after a restart from the lane row: every state names what to poll (the pull
request, the thread). Each transition records one `factory.lane_sync` activity.

**No reviewer on a sync.** A clean sync adds no code of its own. An agent-resolved one does, and it
merges on green checks without the factory's reviewer: the gate for it is the lane's final pull
request (D8), whose diff against the base is exactly what the lane adds, resolutions included, and
which a person reviews. The lane's branch is never the branch that deploys.

_Alternatives:_ a flow run without an issue (rejected above); a sync issue opened by the factory
and run as a normal lane run (rejected: its pull request would be squashed, dropping the ancestry,
and reviewed and risk-classed as if it had written the base's changes); pushing the merge straight
to the lane's branch (rejected: it skips the checks and the branch's protection rules); rebasing
the lane (rejected: it rewrites a branch other runs are based on).

### D5. A cross-lane blocker is finished when its merge is in the candidate's base

`factory-dependencies.ts` stays pure. The watcher additionally supplies each blocker run's
`baseBranch` and `mergeSha`, and whether that sha is contained in the candidate's base (the GitHub
compare API, `base...sha` answering `behind` or `identical`, cached per tick). Same base: as today.
Other base (another lane, or no lane while the candidate has one): finished only when contained,
otherwise `blocker-on-other-branch`. A blocker merged into the "Merge into" branch therefore
unblocks a lane's issue after that lane's next sync, which the base's move already triggers. Stacking
(`factory-stacking.ts`) refuses a blocker with another base before it looks at its branch.
The merge commit is read from the blocker's pull request (`merge_commit_sha`) the first time this
check needs it and kept on the run (`factory_runs.merge_sha`). It is not written by `merge`: a run
merges through four paths (alone, as a batch member, through GitHub's merge queue, or by a person
outside the factory), and the pull request is the one place that knows the commit for all of them
and for runs merged before this change.

### D6. The sentinel watches every base with a recent factory merge

The sentinel's tick takes the distinct `base_branch` values of the factory merges of the last 24
hours on the repository (null read as the factory's setting) instead of the one factory base. The
incident stays per repository and base branch. Admission checks only the incidents of the
candidate's base branch, so `blockedReason` becomes per base: the factory pauses one lane, not the
whole factory.

While the "Merge into" branch has an open incident, no sync into a lane starts: a sync would
carry the broken base into every lane.

### D7. The cross-lane conflict check runs `git merge-tree` on the runner (phase 3)

The server has no checkout, and GitHub has no merge API that writes nothing. Once a day, the
factory asks the enabler's runner for a read-only job in the project's repository:
`git fetch` the lane branches, then `git merge-tree --write-tree --name-only <a> <b>` for each
pair. It writes no branch and no worktree (the fetch only moves remote-tracking refs). The result (pairs and paths) is stored on the lanes and
shown on the settings page and on the board. It needs git 2.38 or later on the runner; with an older
git the check reports itself unavailable instead of guessing.

### D8. Finishing a lane opens a plain pull request, and its merge removes the lane

"Finish lane" is refused while a run of the lane is in flight. Otherwise it opens
`lane → Merge into` with the App token, capped by the member's access like every factory write,
with the lane's merged issues listed and a note that a person must review and merge it. It starts
a sync when the lane is behind (the pull request follows the branch). It is not a factory run: no
risk class is computed, nothing merges or approves it, and no approval request is made. The pull
request number is stored on the lane (`finish_pr_number`), and the action is recorded as a
`factory.finish_lane` activity.

The watcher tick reads that pull request. When it is merged, the factory sets the lane's state to
`finished` (compare-and-set from `active`) and records the activity. A finished lane syncs no more. The branch is left to the person.
Issues that still carry the lane's label then run on the "Merge into" branch, which is where a
late fix of the feature belongs.

### D9. The factory closes a lane run's issue

GitHub acts on `Closes #N` only when the pull request merges into the default branch, so a lane
task's issue would stay open after its work merged. When a run whose `base_branch` is a lane's
branch merges, the factory closes its issue (`closeIssue`, as triage's close does) and comments
with the branch. Closing at the lane merge, not at the lane's finish, keeps the issue list equal
to the work left, and D5 does not depend on it: a blocker with a factory run is judged by where
its merge is, never by its issue being closed. Runs without a lane are unchanged (a factory that
merges into `dev` leaves its issues to GitHub, as today).

### D10. The board's lane filter lists the factory's lanes, not the lanes of the loaded runs

The first version built the filter's options from the runs on screen and hid the filter when none
of them had a lane. A member who just made a lane, or whose lane's runs are outside the loaded
page, saw no filter at all and could not tell whether lanes worked. The options now come from the
lane rows of the factories shown (active and finished), joined with the lanes of the loaded runs
(a removed lane's old runs stay filterable). The filter is shown whenever that list is not empty
or a lane is selected, and hidden only when no shown factory has ever had a lane.

The factory queue spans projects, and a lane is unique per factory only, so an option is keyed by
project and lane: `auth` of project A and `auth` of project B are two options, each named with its
project when more than one project is shown. "No lane" stays one option. With more than eight
options the menu gets a search field, so a member reaches one lane by typing its name. The
board's search box already matches the lane name; its placeholder says so.
_Alternative:_ keep the options from the runs and only stop hiding the filter. Rejected: an empty
"Lane" menu explains nothing, and a lane whose runs all ended would still be missing.

### D11. The lane prefixes default to `lane:` and `lane/`, not `feature:` and `feature/`

`feature:` is a common way to classify issues. A team that already labels issues `feature:billing`
gets a lane, and a `feature/billing` branch, the first time such an issue also carries the factory
label, without anyone asking for one. `feature/<name>` is also the branch a person most often makes
by hand. The defaults become `lane:` and `lane/`, which name the factory's own convention. A
factory saved before this keeps what it reads today: the migration writes `feature:` / `feature/`
into the rows whose prefixes are null, so no existing label or lane changes meaning.
_Alternative:_ a per-user default (`lane/<user>/`). Rejected: D12 already refuses the branch of
another factory, and a user's name in every branch makes lanes harder to share.

### D12. A lane does not adopt another factory's lane branch

D1 lets a new lane adopt a branch that already exists, so a lane can start from work a person
began by hand. Two members of the same project each have their own factory, and with the same
prefixes both would adopt `lane/auth`: two factories syncing, merging into and finishing one
branch. Before a lane is made, the factory looks for an active lane of another factory of the same
project with that branch; when there is one, the issue stays queued with `lane-invalid` and the
reason names the branch and says another member's factory uses it. A branch no factory uses is
still adopted.
_Alternative:_ compare repositories instead of projects. Rejected for now: a factory resolves its
repository from GitHub at each tick and stores none, and two projects on one repository are rare.

## Risks / Trade-offs

- [A lane lives long and its final merge is large] → Hourly syncs keep it containing the base, so
  the final pull request's diff is only the feature. The D7 check reports features that overlap.
- [An agent-resolved sync merges unreviewed] → Its checks must pass, and a person reviews it in the
  lane's final pull request (D4). The lane's branch does not deploy.
- [The repository disallows merge commits] → The sync goes to `needs_human` with that reason.
  Squash would drop ancestry and make every later sync conflict again, so it is never used.
- [CI does not run for pull requests into a lane branch] → The save warns (D1). This repository's
  own workflows filter on `branches: [master]` and need `lane/**` (or the lane branches) added
  before its factory uses lanes.
- [A sync makes every open pull request of the lane out of date] → At most one sync an hour per
  lane, and the merge lane already brings a pull request up to date before it merges.
- [The lane's branch is deleted on GitHub] → Its runs and its sync fail with the reason, and the
  lane shows it. The factory does not recreate a branch that had work on it.
- [A label added after admission is ignored] → Intended (D2). The run card shows its base (phase
  1), so the mismatch is visible, and a member can stop the run and send the issue again.
- [Until the sentinel is per base (D6, phase 2)] → A red "Merge into" branch pauses the lanes too,
  and a red lane branch opens no incident. The lane's own checks still gate each merge.

## Migration Plan

1. Add `factory_runs.base_branch`, `factory_runs.merge_sha` (nullable) and `factory_lanes`
   (`sync_state` defaults to `idle`). No
   backfill: null means the factory's setting, and an unknown merge sha only matters across lanes,
   which did not exist before.
2. Ship D2 and D3 with no lanes configured: every run records the factory's branch, and behavior is
   unchanged.
3. Ship lanes, sync, cross-branch dependencies, issue closing and finishing (phase 1), then the
   sentinel per base and the board filter (phase 2), then the conflict check (phase 3).

Rollback: a server without the change ignores the new columns and table. Runs in flight on a lane
would then follow the factory's branch, so stop or finish lane runs before rolling back.

## Open Questions

None. Decided in review: the factory label admits and the lane label only routes (D1); a sync is
its own state machine with no reviewer (D4); a lane task's issue closes when it merges into the
lane (D9); a lane is a `lane:<name>` label (default prefix, D11), created at first admission (D1); it is marked finished when its
final pull request merges (D8).
