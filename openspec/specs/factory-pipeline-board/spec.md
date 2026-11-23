# factory-pipeline-board Specification

## Purpose

Lets a member see the whole issue factory pipeline at a glance: where each run is, which quality gates it has passed, and why it is waiting, without opening each run.

## Requirements

### Requirement: List and board layouts

The factory view SHALL offer two layouts of the same runs, a list and a board, chosen with a toggle. The list SHALL be the default. The chosen layout SHALL be kept when the member leaves and comes back to the view. The search, project filter and state filter SHALL apply to both layouts.

#### Scenario: Switching to the board

- **WHEN** a member selects the board in the factory view's layout toggle
- **THEN** the view shows the runs that pass the current filters as cards in stage columns

#### Scenario: Layout is remembered

- **WHEN** a member selected the board, left the factory view and opens it again
- **THEN** the view opens in the board layout

### Requirement: Stage columns

The board SHALL show these columns, in this order, and place each run in exactly one of them by its state:

| Column          | Run states                                           |
| --------------- | ---------------------------------------------------- |
| Queue           | `requested`, `queued`                                |
| Triage          | `triaging`                                           |
| Implementing    | `working`, `fixing`                                  |
| PR · Proof · CI | `pr_open`, `waiting_ci`                              |
| Review          | `reviewing`                                          |
| Merge           | `merging`                                            |
| Needs a person  | `needs_info`, `waiting_human`, `failed`, `no_change` |
| Done            | `merged`, `stopped`                                  |

A run state added later and not in the table SHALL be shown in Needs a person, never dropped. Each column header SHALL show the number of runs in it. Within a column, runs SHALL be ordered by queue position in Queue and by most recent activity (completed, admitted or sent time) elsewhere.

#### Scenario: A run in review

- **WHEN** a run's state is `reviewing`
- **THEN** its card is in the Review column and in no other column

#### Scenario: An unknown state

- **WHEN** a run carries a state the client does not know
- **THEN** its card is in the Needs a person column

### Requirement: Board is read-only

The board SHALL NOT let a member move a run between columns. A run's column SHALL change only when its state changes on the server. Run actions (retry, stop, take over) SHALL be offered only where the list already offers them, with the same capability checks.

#### Scenario: Dragging a card

- **WHEN** a member tries to drag a run card to another column
- **THEN** the card does not move and the run's state does not change

### Requirement: Done shows recent runs

The Done column SHALL show only runs that completed in the last 24 hours, and its header SHALL say how many older finished runs are hidden. The Done column SHALL be collapsible. Finished runs older than 24 hours SHALL remain reachable in the list layout.

#### Scenario: An old merged run

- **WHEN** a run merged three days ago
- **THEN** it is not in the board's Done column, the Done header counts it as hidden, and the list still shows it

### Requirement: Stage limits in column headers

When the view is filtered to exactly one project, the Implementing and Review column headers SHALL show the run count against that factory's limit for the stage (its stage limit setting, or its maximum concurrent runs when the stage has none), and the Merge header SHALL say merges run one at a time per repository. Otherwise headers SHALL show the count only.

#### Scenario: One project selected

- **WHEN** the project filter holds one project whose factory allows 20 concurrent runs and 4 of its runs are implementing
- **THEN** the Implementing header shows 4/20

#### Scenario: Several projects

- **WHEN** the view shows runs of two projects
- **THEN** column headers show counts without limits

### Requirement: Run card

Each board card SHALL show the issue number (linked to the issue when the run's pull request names its repository), the project name, the time since the run's most recent activity, and the pull request link when there is one. Activating a card SHALL open the run's implementing thread, or its latest thread when it has no implementing thread.

#### Scenario: Opening a run

- **WHEN** a member activates the card of a run whose implementing thread is known
- **THEN** that thread opens

### Requirement: Flow progress strip

A run card SHALL show the run's flow steps in order, each marked done, current, failed or not reached, from the run's step list, current step and state. A run with no step list (queued, or from before runs recorded their steps) SHALL show no strip. When the run has review verdicts, the review step SHALL show the round number (verdict count). Hovering or focusing a step that an agent ran SHALL show the provider, model and effort it ran with.

#### Scenario: Second review round

- **WHEN** a run with steps triage, implement, review, merge is `reviewing` and has one failed review verdict
- **THEN** triage and implement are marked done, review is marked current with round 2, and merge is not reached

#### Scenario: Failed run

- **WHEN** a run failed while its current step was `review`
- **THEN** the review step is marked failed

### Requirement: Quality gate chips

A run card SHALL show a chip for each gate the run has a result for, and none for a gate it has not reached: risk class (low or high, high listing its reasons on hover), the review verdict of the latest reviewed commit (pass or fail, with the short commit SHA), the regression proof verdict (pass, fail or skipped), and CI (red rounds and conflicts from the run's metrics when any). A review or proof for a commit other than the pull request's latest classified commit SHALL be shown as stale.

#### Scenario: A run held for risk

- **WHEN** a run in `waiting_human` has a passing review, a passing proof and a high risk class with reason "touches auth"
- **THEN** its card shows review pass, proof pass and risk high, and hovering the risk chip shows "touches auth"

### Requirement: Why a run is waiting

A run card in Queue or Needs a person SHALL show one line saying, in plain language, why the run is not moving: the queue wait reason (including the blocking issue numbers), the triage questions count for `needs_info`, the failure reason for `failed`, that nothing needed changing for `no_change`. For `waiting_human` it SHALL give the reason the run recorded when it parked (no review for the commit, review failed, high risk, branch rewritten, unsaved work), and SHALL say the run waits for a person when none was recorded.

#### Scenario: Waiting on overlapping paths

- **WHEN** a requested run waits because its likely paths overlap those of the run for issue 47
- **THEN** its card says it waits on paths shared with #47

#### Scenario: Triage asked questions

- **WHEN** a run is `needs_info` and triage asked two questions on the issue
- **THEN** its card says triage asked 2 questions on the issue

#### Scenario: Held for high risk

- **WHEN** a run is `waiting_human` and recorded that it parked because the change is high risk
- **THEN** its card says it was not merged because it is high risk and needs a person

### Requirement: Active runs first in the list

The factory view SHALL offer an "Active" filter, applied to both layouts, that hides `merged`, `no_change` and `stopped` runs. The list SHALL keep its order: runs waiting for a person, then in progress, in the queue, failed, and ended.

#### Scenario: Active filter

- **WHEN** a member turns on the Active filter
- **THEN** neither layout shows a `merged`, `no_change` or `stopped` run
