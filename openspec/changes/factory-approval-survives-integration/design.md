# Design

## Context

See proposal.md for the evidence. The code this design changes:

- `provedMerge` (`factory-action-provider.ts`) calls `mergeHeld(head)` and only then
  `upToDate()`, which calls `mergeHeld` again on the head the lane produced. `mergeHeld` checks
  the review of the commit, then its risk class against `deps.mergeApproved(sha)`.
- `carryChecks(from, to)` moves the review, the proof and the approval. It runs when the merge
  lane's update-branch made `to` (GitHub refuses that call on a conflict, so it settles
  nothing), and when the runner's `integrate` step merged with no resolved or regenerated path.
- `carryMergeApproval` (`factory-runs.ts`) is a compare-and-set on the stored approval JSON.
- The approval record is `{ sha, userId, at, carriedFrom? }`.
- Risk reasons are display strings, capped at `MAX_REASONS`; the size reason contains a count.
- `busyPathsOf` (`factory-triage.ts`) takes paths from runs in `WORKING_ON_PATHS` or
  `triaging`. `waiting_human` is not one of them.

Constraints: the server has no checkout (the runner has it); the GitHub compare API truncates
large diffs, and these are the large ones; a run's requests go only to the run owner's runner.

## Goals / Non-Goals

**Goals:**

- One request for a person per approved change, when the change does not change.
- A single place that decides whether an approval covers a commit.
- A person can read afterwards every commit that merged on a moved approval.

**Non-Goals:**

- Changing how risk is classified, or what counts as high.
- Moving the review or the proof under the new rules: they keep their own (stricter) carry.
  The new head is reviewed and proved as today.
- Stopping direct pushes to the base branch while approvals are pending.
- A second merge queue or a lock on the base: the merge lane is that already.

## Decisions

### D1. Bring the base in before the hold, and do not wait for checks

In `provedMerge`, when the head's change is high risk, not covered by an approval, the factory
is `low_risk`, and GitHub's merge queue is not required: update the branch first, then hold.

`mergeHeld` splits into its two gates, `reviewHeld(sha)` and `riskHeld(sha)`. The new order:

1. `reviewHeld(head)`, as today.
2. If `riskHeld(head)` would hold: `lane.updateBase()`, a new lane operation that performs the
   update rounds of `bringUpToDate` without `checksOnNewHead`. Its `carried` steps go through
   `carryChecks` as today. A conflict takes the existing `sentBack('conflict')` path.
3. Hold on the head `updateBase` returned.

Not waiting for checks keeps the merge slot short: the checks of the new head run while the
person decides, and the approved retry waits for them in `upToDate` as any merge does.

_Alternative: bring the base in from the flow (an `integrate` before `merge`)._ The default
flow does that already, and runs still arrived behind, because the base moves between
`integrate` and `merge` (CI and review take minutes). The gate is the one place every path
crosses.

_Alternative: hold first and update when the approval arrives (today)._ It guarantees a second
commit whenever the branch is behind, which is the common case under parallel runs.

### D2. One comparison, made on the runner: the change's delta

A new deterministic runner step, `change-delta { from, to, base }`, next to `integrate` in
`runtime/services/factory-steps.ts`. No agent, no network beyond fetching the base. It runs in
the run's implementer workspace, which has both commits.

```
P(c) = git diff --no-renames <merge-base(c, base)> c     per file: multiset of added lines,
                                                          multiset of removed lines
delta(from, to) = per file, the multiset difference of P(from) and P(to), both ways
```

The step answers `{ ancestor, lines, files: [{ path, lines }], filesTruncated, outsideFrom }`.
`lines` is the size of the delta; `files` lists at most 200 of the files that differ
(`filesTruncated` when there were more); `outsideFrom` is the files of the delta that
`P(from)` did not touch. `ancestor` is
`git merge-base --is-ancestor from to`; when false the step answers that and nothing else.

Why this measure and not the commits between `from` and `to`: it does not care who made the
base merge or how (GitHub, `integrate`, weave, the agent resolving a conflict), and a merge
that settled a conflict by keeping both sides gives a delta of zero. Walking commits cannot
size what an agent-resolved merge changed. Lines the base brought are not in either `P`, so 998
lines of somebody else's merge count as nothing.

It is conservative where it is imprecise: a line the pull request added that the base now also
has leaves `P(to)`, and counts as a difference.

_Alternative: `git patch-id`._ It answers only same / not same; the adjustment rule needs a
size and a file list, and one mechanism is better than two.

_Alternative: the GitHub compare API on the server._ Per-file patches are dropped past GitHub's
size limits; today's runs already carry "GitHub gave no diff" in their risk reasons.

The runner is the run owner's, reached through `withRunnerFor` and the certified sink, as
`integrate` is. Its answer is trusted exactly as `integrate`'s `resolvedPaths` is today, which
already decides the current carry. Any failure answers "does not cover".

### D3. The approval gate decides lazily, in one function

`riskHeld(sha)` becomes:

```
approval covers sha            → pass
no approval                    → hold
approval of another commit     → coverage = approvalCovers(approval, sha)
                                 pass (and move the approval) or hold
```

`approvalCovers` (a pure function in a new `factory-approval-carry.ts`, given the delta, the
two risk classifications and the factory's limit) answers `same`, `adjustment` or a refusal
with its reason:

- not an ancestor, or no delta available → refuse
- `lines === 0` → `same`
- limit is 0, or `lines > limit` → refuse
- the file list was cut short, or `outsideFrom` is not empty → refuse
- a risk key of `sha` that the approval's keys lack → refuse
- otherwise → `adjustment`

The delta's `from` is always `approval.carriedFrom ?? approval.sha`: the commit a person
approved. That is what makes adjustments not add up, and why no count of moves is needed. (A
"max two automatic moves" rule was considered: with a cumulative bound it adds a setting and
blocks the case of three clean base merges in a row.)

The eager `carryChecks` path stays as it is: it needs no runner call and covers the most
common case. The lazy check covers everything else, including a commit the agent pushed.

The refusal reason is added to the hold message, so the member sees why they are asked again
("the change differs from the approved commit by 852 lines; this factory follows 50").

### D4. Risk keys

`classifyRisk` returns, besides `reasons`, `keys: string[]`, uncapped and stable:
`size`, `sensitive:<path>`, `finding:<kind>:<path>`, `contract:<sha1 of the hint, 12 chars>`.
`size` does not carry the count, so a change that was over the limit and grew is not a new
reason. Approving stores the keys of the approved classification in the approval record
(`riskKeys`). An approval without `riskKeys` (recorded before this change) can only be `same`.

### D5. The approval record and its compare-and-set

```ts
{ sha, userId, at,
  carriedFrom?: string,            // the commit the member approved
  riskKeys?: string[],
  moves?: Array<{ to: string, at: string, kind: 'same' | 'adjustment',
                  lines: number, files: string[] }> }   // files capped at 20
```

`carryMergeApproval(runId, from, to, move)` keeps its compare-and-set on the stored JSON, so an
approval a member wrote meanwhile wins. Row count checked; a lost race re-reads and holds.
Per docs/architecture/state-machines.md this is a guarded write of one field, not a new state.

### D6. The trace

After a successful move: a pull request comment (the same client call as the review comment),
an activity `factory.approval-moved` written for the approver through
`services/activities/server-activities.ts`, and the `moves` on the run detail. The comment is
posted after the compare-and-set and its failure is logged, never retried into a second
comment: `moves` is the record, the comment is a notice.

### D7. Two settings on `factory_settings`

- `approval_adjust_max_lines` INTEGER NOT NULL DEFAULT 0, contract `approvalAdjustMaxLines`
  0..200. 0 is off.
- `hold_paths_awaiting_approval` INTEGER NOT NULL DEFAULT 0, contract `holdPathsAwaitingApproval`.

Both through `saveFactorySettingsInput` (needs `steer`, as the other factory settings), rendered
with `SettingRow` and indexed in `settings-index.ts`. The first row's description says that
the factory then merges lines no person read.

### D8. Paths of a run waiting for approval

`busyPathsOf` takes two more inputs per run: whether it is parked for a high-risk approval
(`state === 'waiting_human'` with the high-risk hold reason and a pull request) and when it
parked (`completedAt`). With the factory's setting on, such a run holds its paths while
`now - completedAt < 12h`. The 12 hours are a constant, `APPROVAL_PATH_HOLD_MS`.

This is the least valuable part and the only one that costs throughput: it stops _new_ runs
from starting on the same files, and does nothing about runs already in flight or about pushes
by people, which caused most of 2026-11-24's base movement. Hence off by default and last in
the task order, so it can be dropped without touching the rest.

## Risks / Trade-offs

- [With adjustments on, up to 200 lines no person read merge under a person's approval] → Off
  by default; files limited to the approved ones; no new risk key; the review must pass on the
  new commit; every move is commented on the pull request.
- [A sensitive change fits in few lines (an auth check removed)] → A sensitive path the
  approved change did not touch is a new key and a new file, both refused. Inside an already
  approved sensitive file the review is the remaining guard: the settings text says so.
- [The delta is computed where the agent has run] → Same trust as `integrate` today; the step
  is server-requested, runs outside the agent, and reads git objects by SHA that GitHub also
  has. Not a new boundary, but the settings text does not call it a security control.
- [Updating before the hold pushes merge commits to pull requests nobody approves for days] →
  One merge per time the run reaches `merge`; no checks are waited on; the alternative was the
  same merge after the approval.
- [`updateBase` holds the merge slot during GitHub's update-branch call] → Seconds, without the
  check wait.
- [Path hold starves the queue when nobody approves] → Off by default, 12-hour lapse, and the
  queue reason names the cause.
- [Runner offline at the gate] → The run parks and asks the person, as today.

## Migration Plan

One additive migration (two columns with defaults); both settings default to today's behavior.
D1, D2 and D3 with `same` change behavior for every factory on deploy: approvals move in more
cases and holds happen on an updated head. Stored approvals stay valid (new fields optional).
The runner step is new: a runner that does not know `change-delta` answers an error, which is
"does not cover", so server and runner can deploy in either order. Rollback is a revert; the
columns can stay.

## Open Questions

- Whether the board should offer "approve again" with the delta inline when a refusal is an
  adjustment over the limit. It changes no rule here and can follow.
