# Proposal

## Why

A member's approval to merge a held high-risk change names one commit, and that commit rarely
reaches the merge. On 2026-11-24, 10 approved runs came back to `waiting_human` with another
head commit (#448, #450, #451, #453, #454, #455, #458, #459, #478, #487):

| What changed after the approval                                            | Runs                   |
| -------------------------------------------------------------------------- | ---------------------- |
| Only a merge of the base, a conflict settled without an agent; same change | #451, #453, #455, #459 |
| A merge of the base the agent resolved, no other commit                    | #450, #454             |
| A merge of the base and a small agent commit (9 to 47 changed lines)       | #448, #458, #487       |
| A merge of the base and a rewrite (over 850 changed lines, 16 files)       | #478                   |

Three causes, in the code as it is:

- `merge` asks for the approval on the head it finds, before it brings the base in. Runs
  approved at 11:29Z were already behind the base, so the approval produced a new commit.
- The approval follows a base merge only when the merge settled nothing (commit `301d5953a`).
  A merge that settled one conflict mechanically drops it, although the review passes again and
  the pull request's change is the same.
- A run waiting for its approval holds no paths, so runs on the same files start meanwhile.

The merge lane already serializes merges, and triage already holds overlapping runs: this is
not a race for the base branch, it is the approval gate asking the same person twice.

## What Changes

- Document the approval itself, which shipped without a requirement: a member with `steer`
  approves the held head commit of a high-risk change.
- **Ask on a current head.** `merge` brings the pull request up to date with its base before it
  parks a high-risk change for a person, without waiting for the checks of the new head.
- **The approval follows the same change.** An approval of commit A lets commit B through when
  B descends from A and the pull request's change against its base is the same at both, whoever
  made the base merge and whatever it settled. The review, the checks and the proof of B are
  still required.
- **The approval may follow a small adjustment** (factory setting, off by default). When the
  change at B differs from the approved one by at most the factory's limit of lines, only in
  files the approved change already touched, with no risk reason the approved commit did not
  have, the approval moves to B. The difference is always measured against the commit the
  member approved, so adjustments cannot add up past the limit.
- **Every move of an approval leaves a trace:** a comment on the pull request, an activity of
  the approver, and the run detail show the approved commit, the new one and the difference.
- **A run waiting for its approval may hold its paths** (factory setting, off by default), for
  at most 12 hours of waiting.

Not in this change: direct pushes to the base branch by people (they move the base like any
merge; the two carry rules cover them), and any change to how risk is classified.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `issue-factory`: adds the requirements for the merge approval, the head it is asked on, when
  it moves to another commit and how that is recorded; changes "Runs with overlapping paths do
  not work at the same time" for a run waiting for its approval.

## Impact

- **Server** (`packages/server/src/services/factory/`): `factory-action-provider.ts` (the order
  in `provedMerge`, the approval check in `mergeHeld`), `factory-merge-lane.ts` (update without
  waiting for checks), `factory-runs.ts` (`carryMergeApproval`), `factory-risk.ts` (stable
  reason keys), `factory-run-control.ts` (keys stored with the approval), `factory-triage.ts`
  (`busyPathsOf`), `factory-settings.ts`.
- **Runtime** (`packages/runtime/src/services/factory-steps.ts`): a new deterministic step that
  compares a pull request's change at two commits. No agent.
- **Shared**: `contracts/factory.ts` (approval record, two settings), the runner step request
  and result, one migration for two `factory_settings` columns.
- **Client**: two rows in the factory settings (and `settings-index.ts`), the carried approval
  in the run detail.
- **Docs**: `openwiki/architecture/issue-factory.md`.
- No change to the public API v1, the flow file format or GitHub App permissions (the pull
  request comment uses the permission the review comment already uses).
