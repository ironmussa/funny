# Spec Delta

## MODIFIED Requirements

### Requirement: A factory may merge into a branch other than the default

A factory's settings SHALL name the branch its runs merge into, empty meaning the repository's default branch on GitHub. It is the base branch of every run admitted without a lane (`factory-lanes`); a run in a lane uses its lane's branch instead. A run SHALL use the base branch recorded on it at admission: it SHALL start its branch from that branch, its pull request SHALL target it, its integration, stacking retarget, merge lane and "no change" check SHALL use it, and a later change of the factory's setting SHALL NOT move a run already admitted. Flows and their prompt files SHALL still be read from the repository's default branch. A pull request the agent opened against another branch SHALL be retargeted to the run's base branch before the run goes on, and a run whose pull request cannot be retargeted SHALL stop there. A save SHALL refuse a name git does not accept as a branch.

#### Scenario: A factory that merges into develop

- **WHEN** the enabler sets the factory's branch to `develop` and an issue runs
- **THEN** the run's worktree starts from `origin/develop`, its pull request targets `develop`, and the flow is read from the default branch

#### Scenario: A pull request opened against the default branch

- **WHEN** the factory merges into `develop` and the agent opens its pull request against `main`
- **THEN** the factory retargets the pull request to `develop` before CI and review

#### Scenario: The setting changes while a run is in flight

- **WHEN** a run was admitted while the factory merged into `develop` and the enabler changes the setting to `main`
- **THEN** that run still merges into `develop`, and runs admitted afterwards use `main`

### Requirement: Dependent issues can be stacked

A factory SHALL support `dependencies: wait` (the default: an issue waits until its blockers are
finished) and `dependencies: stack`. With `stack`, an issue whose blocker has a run in flight with
a branch and the same base branch SHALL start on top of the blocker's branch with its pull request
against it; the queue SHALL merge the blocker first, and the stacked run SHALL park in
`waiting_human` if the blocker's run fails or is stopped or its pull request is closed without
merging. The system SHALL bring each new commit of the blocker's branch into the runs stacked on
it, SHALL NOT put a stacked run in the same batch as its blocker, and, once the blocker merged,
SHALL retarget the stacked pull request to the run's base branch and bring the base in before the
run enters the queue. A blocker whose run has another base branch SHALL NOT be stacked on
(`factory-lanes`).

#### Scenario: Work on a dependent issue starts early

- **WHEN** issue #21 is blocked by #20, #20's run is in flight on the same base branch, and the factory uses `stack`
- **THEN** #21's implementer starts on #20's branch instead of waiting for #20 to merge

#### Scenario: The blocker is squash-merged

- **WHEN** #20 is squash-merged while #21 is stacked on it and already contains #20's last commit
- **THEN** #21's pull request is retargeted to the base branch, the base merges into it without a conflict from #20's own changes, and #21 then enters the queue

#### Scenario: The blocker gets a fix after the stacked run started

- **WHEN** #20's implementer pushes a review fix while #21 is stacked on it
- **THEN** the fix is merged into #21's branch by the integrate step, not left for merge time

#### Scenario: The blocker fails

- **WHEN** #20's run fails while #21 is stacked on it
- **THEN** #21 parks in `waiting_human` with the blocker's failure as the reason

#### Scenario: The blocker is in another lane

- **WHEN** #21 in lane `feature/a` is blocked by #20 whose run merges into `feature/b`
- **THEN** #21 is not stacked on #20 and waits as `blocker-on-other-branch`

### Requirement: A red base branch after a factory merge opens an incident

When a repository's base branch turns red within 24 hours of a factory merge, the system SHALL
open one incident for that repository and base branch, pause admissions of the runs whose base
branch is that branch (in every factory on the repository) with a reason naming the incident, and
run a sentinel over the factory merges since the last green base commit. Runs whose base branch is
another branch of the repository, such as another lane's (`factory-lanes`), SHALL still be
admitted. When the sentinel names a culprit merge, the system SHALL open a revert pull request for
it and notify that run's enabler; otherwise it SHALL notify every affected enabler. Revert pull
requests SHALL NOT be merged automatically. The incident SHALL close, and admissions resume, when
the base branch is green again or a member closes it.

#### Scenario: A merge breaks the base branch

- **WHEN** the base branch turns red an hour after #12 merged and the sentinel names #12
- **THEN** a revert pull request for #12 is opened, #12's enabler is notified, and no factory on
  the repository admits issues for that base branch until it is green

#### Scenario: Red long after any factory merge

- **WHEN** the base branch turns red three days after the last factory merge
- **THEN** no incident is opened

#### Scenario: A red lane branch

- **WHEN** the lane branch `feature/a` turns red after a factory merge into it
- **THEN** new `lane:a` issues wait on the incident, and `lane:b` issues and issues without a lane are still admitted
