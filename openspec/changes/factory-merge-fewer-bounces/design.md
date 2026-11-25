# Design

## Context

See proposal.md for the evidence. What the code does today:

- `merge` (`factory-action-provider.ts`, through `factory-merge-lane.ts`) merges the proved
  commit with `pinnedMerge` (`factory-pull-requests.ts`, `mergePinned`). A refusal comes back as
  `not-mergeable` with a reason, whatever caused it; only `headMoved` is told apart, and it also
  ends as `not-mergeable`. The run parks in `waiting_human`. The spec already says a merge
  happens "only if the base branch has not moved since; if it moved, it SHALL bring the base in
  and check again": the lane checks that before the call, and the refusal is the race between
  that check and GitHub's answer.
- `approvalNotMoved` (`factory-action-provider.ts`) asks the runner for the `ChangeDelta` from
  the approved commit to the held one (`ancestor`, `lines`, `files`, `filesTruncated`,
  `outsideFrom`) and `approvalCovers` (`factory-approval-carry.ts`) turns it into a refusal
  reason. The reason ends in the run's error text; the delta is dropped. The approval request
  (`factory-approval-requests.ts`) shows the held commit, its size and its risk reasons.
- A retried run goes back to `requested`, where `pathsHeld` (`factory-watcher.ts`) and triage's
  `heldForPaths` hold it when its contract's likely paths overlap a run in
  `WORKING_ON_PATHS`. Run #450, with pull request #466 open and approved, sat in `requested`
  with `{ kind: 'paths-overlap', blockers: [480] }`.
- `busyPathsOf` (`factory-triage.ts`) counts no `waiting_human` run. Group 6 / D8 of
  `factory-approval-survives-integration` designed the exception and was not built.

Constraints: no agent decides a merge or describes a change to the approver; only a member's
browser session approves, for the commit shown (`expectedSha`); statuses change with a
compare-and-set from the stored state (`docs/architecture/state-machines.md`).

## Goals / Non-Goals

**Goals:**

- A run that merges on the second try without a person never shows `waiting_human`.
- A second approval costs the member the reading of the difference, and the difference is on
  the screen where they approve.
- An approved run is not put behind runs that started after it.

**Non-Goals:**

- Approving a difference as something smaller than a commit. The approval stays a statement
  about one commit; only what is shown changes.
- Changing `approval_adjust_max_lines`, the risk classification or the review.
- Showing the patch of the difference in funny. The files and counts are shown; the lines are
  read on GitHub (D4).
- Stopping people's pushes to the base branch. D1 makes them harmless at merge time instead.

## Decisions

### D1. A refused merge is classified from the two branches, not from GitHub's message

After `ci.merge` answers `not-mergeable`, the provider asks the lane which branch moved since
the commit it tried to merge (`movedSince(sha)`, from the same `positionOf` the lane uses to
bring a branch up to date): the pull request's head is another commit (`head`), the head is
behind the base (`base`), or `neither`. With `neither`, or when it cannot say, the refusal
ends the step as today.

With a branch moved, `mergeOnCurrentBase` loops: `upToDate` (base in, checks, the review and
risk gates on the new head), the proof, the merge. `MAX_STALE_MERGES` (3) refusals in one visit
to `merge` park the run with the hold reason `base keeps moving`. The approval is re-decided by
the existing `approvalNotMoved` on the new commit, so nothing about approvals is special here.

GitHub's 405 text ("not mergeable", a required check, a rule) was rejected as the signal: the
same status covers a branch that is behind and a rule nobody can satisfy, and #450's message
blamed the missing `funny/regression-proof` requirement while a retry fixed it. The two commits
are facts the lane already owns. The classification lives in the lane and not in
`mergePinned`, as first drafted: the lane already reads the head and its distance to the base,
and `mergePinned` would have needed a second way to know them.

**Checked against #450 (task 1.1).** The refusal was the race this decision handles:

- `master` moved to `2aa66a2d2` by a push at 01:32:13Z; GitHub answered 405 to the merge of
  `cb1890e` in the step that ended at 01:32:15Z. `cb1890e` includes `128cefd26` (the base
  before the push) and not `2aa66a2d2`. The head had not moved.
- `master` has no branch protection and no ruleset, so no rule refused the merge and a branch
  that is merely behind would have merged: the 405 is GitHub's answer while the base has just
  changed. The factory's advice in the hold ("require the `funny/regression-proof` check") did
  not apply. GitHub's own message is not in the log; the hold kept only the status.
- A manual retry at 01:34:56Z was enough: the run merged at 02:31:02Z on `a2fc22c` with the
  same approval. Of those 56 minutes, 50 (01:35 to 02:25) were spent in the queue behind #480
  for its paths, with pull request #466 open and approved: the case D5 removes.

So the two commits classify this refusal correctly (base moved, head did not). A refusal
that is retried never shows its reason; one that parks keeps GitHub's own message next to the
status (task 1.5).

Bounded retry with an explicit policy, inside the lane's existing Effect scope: no backoff is
needed, since each attempt waits for a full CI round.

### D2. The hold records an "approval gap" on the approval it is about

`approvalNotMoved` already has everything: the approved commit, the delta's `lines`, `files`
and `outsideFrom`, both sets of risk keys and the refusal reason. `approvalGapOf`
(`factory-approval-carry.ts`, pure) turns them into a `gap` (the held commit, lines or null,
at most 20 files and a count of the rest, the files outside the approved change, the new risk
keys, the reason), and `noteApprovalGap` writes it INTO the stored merge approval
(`factory_runs.merge_approval`, a compare-and-set on the stored value, like a carry).

Inside the approval and not in a column of its own, as first drafted: the gap is a fact about
one approval and one held commit, and it must vanish exactly when that approval is replaced
(a new approval writes a new record) or follows (a carry drops it). A separate column would
need a writer for each of those exits. `approvalGapFor(approval, heldSha)` in
`@funny/shared/contracts/factory` answers the gap only when it is about the commit the run is
held on, so a gap of a head the run has left shows nothing. No migration, and the run view
already carries `mergeApproval` to the board, the thread card and the agent's tool; the
approval request stores only its commit, and the card reads the gap from the run.

When the delta is unavailable or the branch lost the approved commit, `lines` is null and the
screen says the difference could not be computed (spec scenario).

Alternative rejected: let the agent that asks for the approval describe the change.
`factory-agent-tools` forbids it, for the reason that still holds: the agent wrote the change.

### D3. An approval of the held commit resets the baseline

No code change: `approveMerge` records the held commit with no `carriedFrom`, and
`approvalNotMoved` compares from `carriedFrom ?? sha`. A test pins it, because D2 makes it the
rule the member relies on ("I read the difference from A, so B is what I approved").

### D4. Where the difference is read

The card and the panel show counts and files, and one link to GitHub's compare view of the two
commits. That view also shows the base's commits when the base was merged in between, so it is
labelled "commits since the approval", not "the difference". Shipping the delta's patch through
the runner step would show exactly the difference, at the cost of a new payload with source
code in a run row; left for later (Open Questions).

### D5. A run with a pull request skips the path wait

`pathsHeld` and triage's `heldForPaths` return "not held" for a run that has a pull request.
The path wait exists to keep two implementers off the same files; a run with a pull request has
no implementer to start, and making it wait only lets later changes merge first and turn its
integration into a conflict. It keeps holding its own paths through its step's state, as today.

Narrower alternative considered: skip the wait only with an approval in force. Rejected: a
low-risk run with a green pull request suffers the same reordering, just without a person in
the loop.

The merge order is untouched: the lane still orders by admission.

### D6. Paths of a run waiting for approval

As D8 of `factory-approval-survives-integration`, unchanged: `busyPathsOf` takes whether a run
is parked for a high-risk approval (`waiting_human`, `HIGH_RISK_HOLD`, a pull request) and
since when (`completedAt`); with `factory_settings.hold_paths_awaiting_approval` on it holds
its paths for `APPROVAL_PATH_HOLD_MS` (12 hours). Off by default. The watcher's pass already
reads every run; triage's `busyPaths` reads the parked ones apart (`awaitingApproval`), since
they hold no slot. A run held only by such runs gets the wait reason `paths-awaiting-approval`.

That design called this "the least valuable part" because people's pushes moved the base most
on 2026-11-24. The logs of the day after show the other case: five runs started on #458's files
while it waited. D5 fixes the order once the run is approved; D6 stops the later runs from
starting at all, at the price of their throughput, which is why it stays a setting.

The MODIFIED requirement and group 6 move here; the earlier change drops both (tasks 5.x) so
the two deltas do not modify the same requirement twice at archive.

## Risks / Trade-offs

- [A refusal that is really a rule, while the base also moved, costs up to three CI rounds
  before it parks] → Bounded at three; the reason then names both.
- [The gap makes a second approval quick, and a member may stop reading it] → The gap lists
  files the approval did not cover and new risk reasons first, and the approval still names the
  whole commit; the review and the checks still gate the new commit.
- [D5 lets two runs with overlapping paths be in flight] → Already the case whenever triage's
  likely paths miss; the lane merges one at a time on the current base, and the later run meets
  the conflict in its own integration.
- [D6 on: a parked run nobody approves blocks its files] → 12 hours, then released; the queue
  reason names the run to approve.
- [A gap outlives the hold it was written for] → It is read only for the commit it names
  (`approvalGapFor`), a new approval replaces it and a carry drops it; tested on the run table.

## Migration Plan

One migration (128): `factory_settings.hold_paths_awaiting_approval` (integer, null: off).
Additive; rollback is deploying the previous build, which ignores it and the approval's `gap`.
The server carries the behavior. The runner needs a deploy only for the agent's run list to
print the difference (`describeRun`); an older runner ignores the field. Runs already parked
have no gap and show as a first approval until they are held again.

## Open Questions

- Whether to show the difference's patch inside funny (D4). Decide after using the counts and
  the link for a week.
- Whether `hold_paths_awaiting_approval` should default to on. Decide from the path-hold
  counter once D5 is live.
