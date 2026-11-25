# Proposal

## Why

High-risk factory runs reach `merge` several times before they merge. In the server logs of
2026-11-23 and 2026-11-24 the factory held a run for a high-risk approval 58 times, and runs
#450 and #458 were held at least 5 times each. The merge itself rarely fails: what repeats is
the approval. Three causes account for it:

- A run parked for an approval holds no paths. Other runs start on the same files and merge
  first; once approved, the run queues behind them (#458 waited for #486, #489, #478, #453 and
  #454), the base moves under it, an agent fixes the result, and the approval no longer covers
  the new commit.
- When the approval is lost, the member is asked to approve the whole pull request again,
  although what changed since the commit they approved was 8 lines (#480) or 61 lines (#458).
- A merge GitHub refuses because the base moved a minute earlier parks the run for a person
  (#450, 405 on 2026-11-25 after a push to `master`), although bringing the base in and trying
  again needs nobody.

`factory-approval-survives-integration` made an approval follow the same change and small
adjustments. This change removes the reasons the change stops being the same, and makes the
remaining second approvals cheap.

## What Changes

- **A refused merge is tried again when the base or the head moved.** The run goes back through
  integration (base in, checks, proof) and merges, without a person. Only a refusal that no
  retry can fix (a branch rule, a missing permission) parks the run, as today.
- **A second approval request shows what changed since the approved commit.** When a member
  already approved a commit of the pull request and the approval does not cover the held one,
  the hold says so: the approved commit, how many lines of the change differ, in which files,
  which of them the approved change did not touch, and any new risk reason. Shown on the
  approval card in the thread, in the run panel of the factory board and by the agent's run
  list. The approval is still given for the whole held commit (`expectedSha` unchanged).
- **A run that already has a pull request does not wait for paths.** A retried run with an open
  pull request goes straight to integration instead of queueing behind runs that started on the
  same files after it.
- **A run parked for a high-risk approval can hold its paths** (a factory setting, off by
  default, at most 12 hours). This is group 6 of `factory-approval-survives-integration`,
  designed there and not built; it moves to this change so that one can be archived.
- `approval_adjust_max_lines` is not changed: raising it would merge more lines nobody read,
  and showing the difference makes that unnecessary.

Out of scope: a model that discharges risk reasons, and ordering pull requests that add lint
rules (they collide with every change merged after them).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `issue-factory`: a refused merge is retried when the base or head moved; a hold after a lost
  approval records what changed since the approved commit; a run with a pull request does not
  wait for paths; a run parked for an approval can hold its paths.
- `factory-pipeline-board`: the run panel shows what changed since the approved commit.

## Impact

- Server: `services/factory/` (`factory-action-provider.ts`, `factory-merge-lane.ts`,
  `factory-approval-carry.ts`, `factory-triage.ts`, `factory-watcher.ts`, `factory-runs.ts`,
  `factory-flow-runs.ts`, `factory-settings.ts`, `factory-agent-tools.ts`), one migration
  (`factory_settings.hold_paths_awaiting_approval`). Core: `github-app/check-runs.ts` keeps
  GitHub's message. Runtime: `agent-factory-tools.ts` prints the difference.
- Shared: `contracts/factory.ts` (the merge approval gains its `gap`, the wait reason
  `paths-awaiting-approval`, the setting).
- Client: the approval request card, the factory run panel, the factory settings row and
  `settings-index.ts`.
- Other change: `factory-approval-survives-integration` loses its group 6 and its MODIFIED
  "Runs with overlapping paths" requirement.
- Docs: `openwiki/architecture/issue-factory.md`.
- No change to who can approve, to `approveMerge`, or to the runner's data channel.
