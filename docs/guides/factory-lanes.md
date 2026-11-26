# Factory lanes

Lanes let one issue factory work on multiple feature branches in parallel while keeping each branch
up to date with **Merge into**.

## Joining a lane (two labels)

To send an issue to a lane in automatic mode, the issue needs **two labels**:

1. The factory's own label (for example `ready-for-agent`).
2. A lane label matching the factory's **Lane label prefix** (default `lane:`, for example
   `lane:billing`). A factory saved before this default changed keeps `feature:` / `feature/`.

An issue with only `lane:billing` and without the factory's label is not picked up and creates no
branch. In manual mode, sending an issue that carries `lane:billing` routes it to that lane.

When the first issue for `lane:billing` is admitted, the factory creates the `lane/billing` branch
from **Merge into** (using the **Lane branch prefix**, default `lane/`) and checks whether the
repository's GitHub Actions workflows exclude that branch. Both prefixes and **Merge into** are
fixed while the factory has lanes.

A lane never takes over a branch that another member's factory on the same project already uses as
a lane: the issue stays queued with `lane-invalid` and says which branch. Change your factory's lane
prefixes (or name the lane differently) to work in parallel. A branch no factory uses, such as one a
person started by hand, is adopted.

## Frozen base branch

Each run freezes its target branch (`factory_runs.base_branch`) when it is admitted. Changing
**Merge into**, retrying, or restarting never moves an in-flight run to a different branch. Each
lane also has its own merge queue (`merge:<repo>:<lane branch>`), so runs on different lanes can
merge in parallel.

## Keeping lanes in sync

As **Merge into** advances, the factory periodically merges it into each active lane through a
`factory/sync/<name>` branch and pull request (`factory-lane-sync`):

- Clean merges wait for CI and merge into the lane using a **merge commit** (merge commits must be
  enabled on the repository so git preserves both parents; if merge commits are disabled, the sync
  stops in `needs_human` with an explanation).
- Conflicts start a resolution thread on the enabler's runner (up to three attempts before moving to
  `needs_human`).
- You can trigger **Sync now** or **Retry sync** from **Settings > project > Factory > Lanes**.
- Syncs do not take issue concurrency slots and pause while **Merge into** has an open sentinel
  incident.

## Cross-branch dependencies (`blocker-on-other-branch`)

If an issue is blocked by another issue that merged into a different branch, the factory waits with
reason `blocker-on-other-branch` until that merge commit is contained in the candidate's base branch
(for example after the blocker's lane is finished and the candidate's lane has synced). Stacking
never stacks across different base branches.

## Closing lane issues

Because GitHub only auto-closes issues when a pull request merges into the default branch, the
factory closes a lane run's issue and comments with the lane branch name once its pull request
merges into the lane.

## Finishing a lane

When all runs in a lane have completed, click **Finish lane** in **Settings > project > Factory >
Lanes**. The factory opens a pull request from the lane branch into **Merge into** listing the
lane's merged issues for a person to review and merge (and starts a sync first if the lane is
behind). Once that pull request is merged, the factory marks the lane `finished`, stops syncing it,
and routes any future issue carrying its label to **Merge into**.
