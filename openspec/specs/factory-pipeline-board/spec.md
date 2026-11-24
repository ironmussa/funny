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

Each board card SHALL show the issue number (linked to the issue when the run's pull request names its repository), the project name, the time since the run's most recent activity, and the pull request link when there is one. Activating a card SHALL open the run's detail panel. The panel SHALL link to the run's implementing thread, or its latest thread when it has no implementing thread.

#### Scenario: Opening a run

- **WHEN** a member activates the card of a run
- **THEN** that run's detail panel opens, and it links to the run's implementing thread

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

### Requirement: Run detail panel

The factory view SHALL show a run's detail in a side panel over the current layout, opened from a board card or from a list row's details button. While the panel is open the view's URL SHALL name the run (`run` search parameter), so the URL opens the same panel; closing the panel SHALL remove the parameter. A URL naming a run that is not among the listed runs SHALL show no panel and SHALL remove the parameter. The panel SHALL follow the run as it changes (state, steps, verdicts) without being reopened. The list row's title SHALL keep opening the run's thread.

#### Scenario: Linking to a run

- **WHEN** a member opens `/factory?run=<id>` for a run the view lists
- **THEN** the view opens with that run's detail panel

#### Scenario: A run that is not listed

- **WHEN** a member opens `/factory?run=<id>` for a run the view does not list
- **THEN** no panel opens and the `run` parameter is removed from the URL

#### Scenario: The run moves on while the panel is open

- **WHEN** the panel shows a run in `reviewing` and the run's state becomes `merging`
- **THEN** the panel shows `merging` without being reopened

### Requirement: Run detail content

The panel SHALL show, in pipeline order and only for what the run has reached:

- the issue number, title, project, state and pull request link, with the same run controls (PR, retry, stop) and capability checks as the list, and right under them why the run parked or failed, as the board card says it;
- the flow's steps with their status, and the flow's name, source and commit;
- triage's decision: the contract's acceptance criteria for `ready`, the questions asked for `needs_info`, the proposed parts for `too_big`, that no contract was produced for `none`; a superseded decision SHALL be marked as such;
- the regression proof: verdict, commit, finding, test files and commands;
- one entry per review verdict, oldest first: the commit (and the commit it was carried from), verdict, summary, and each finding with its severity, title and file location;
- the risk class and its reasons, and the CI rounds with red rounds and conflicts.

Every agent step the run started (triage, implementer, each reviewer) SHALL link to its own thread.

#### Scenario: Two review rounds

- **WHEN** a run has a failed review of commit `aaa1111` with one high finding in `src/a.ts:12`, then a passing review of `bbb2222`
- **THEN** the panel lists both verdicts, oldest first, the first one showing the finding's severity, title and `src/a.ts:12`, and each linking to its reviewer's thread

#### Scenario: Triage asked on the issue

- **WHEN** a run is `needs_info` and triage asked two questions
- **THEN** the panel's triage section lists the two questions and links to the triage thread

### Requirement: Factory health header

The factory view's header SHALL summarise the runs it lists, whatever the filters: the runs in flight, the runs needing a person (the board's Needs a person column), the runs merged in the last 24 hours, and over the runs that started in the last 7 days the share whose first review passed (among runs with at least one review), the number of merge holds, and the median time from admission to merge. A figure with nothing to measure SHALL show as a dash.

#### Scenario: First-pass review rate

- **WHEN** in the last 7 days three runs were reviewed and two of them passed their first review
- **THEN** the header shows a first-pass review rate of 67%

#### Scenario: Nothing reviewed

- **WHEN** no run of the last 7 days has a review
- **THEN** the first-pass review rate shows as a dash

### Requirement: Incident banners

For each project with listed runs whose factory has an open incident (its base branch turned red after a factory merge), the factory view SHALL show a banner above the layouts with the repository and branch, what the sentinel found (the merge it points at and the revert it opened, or why it could not name one), and the action to close the incident, with the same behavior and capability checks as the project settings. With no open incident there SHALL be no banner.

#### Scenario: A paused factory

- **WHEN** a project's factory has an open incident pointing at pull request 34 with revert pull request 50
- **THEN** the factory view shows a banner naming the repository and branch, linking to pull requests 34 and 50, with the close action

### Requirement: Time in the current step

A board card of a run in Triage, Implementing, PR · Proof · CI, Review or Merge SHALL say how long the run has been in its current step: since the latest execution of that step started. When the current step has no execution yet (the run waits for the step's slot, such as the repository's merge slot), the card SHALL say the run is waiting, since the previous execution ended. A run without step timings SHALL show neither.

#### Scenario: A long review

- **WHEN** a run's current step is `review` and its latest review execution started two hours ago
- **THEN** its card says it has been in review for 2 h

#### Scenario: Waiting for the merge slot

- **WHEN** a run's current step is `merge`, it has no merge execution yet, and its last execution ended 20 minutes ago
- **THEN** its card says it has been waiting for 20 min

### Requirement: Step timeline in the run panel

The run panel SHALL show the run's step executions in start order, each with its step, attempt (when more than one), status and duration (running ones up to now), and between two executions the time the run waited when it is a minute or more. A run without step timings SHALL show no timeline.

#### Scenario: A retried step and a wait

- **WHEN** a run's `ci` step ran twice (the first attempt failed) and its `merge` started 15 minutes after `review` ended
- **THEN** the timeline shows both `ci` attempts with their status and duration, and a 15 min wait before `merge`

### Requirement: Median time per stage

Each board column header for Triage, Implementing, PR · Proof · CI, Review and Merge SHALL show the median time that runs spent in that stage, over the step executions that ended in the last 7 days among the listed runs; a run's time in a stage is the sum of its executions of the stage's steps. A column with nothing to measure SHALL show no median. The steps of each stage are those of the built-in flows (`triage`; `implement`, `address`; `pull-request`, `regression-proof`, `ci`; `review`; `merge`); other steps count in no column.

#### Scenario: Review is the bottleneck

- **WHEN** three runs spent 10 min, 40 min and 2 h in review in the last 7 days
- **THEN** the Review column header shows a median of 40 min

### Requirement: Runs without an issue

A run that has no issue SHALL be shown, on its card, in the list and in the run panel, by
its trigger's name (or "Run now" and the flow's name for a run a member started) in place of
the issue number and title, with no issue link. The panel SHALL list the run's input values
and SHALL omit the triage, regression proof and review sections. The board SHALL place a run
in the state `done` in the Done column.

#### Scenario: A scheduled run's card

- **WHEN** the board shows a run started by the schedule trigger "Nightly audit"
- **THEN** its card shows "Nightly audit" where an issue run shows its issue number, and no issue link

#### Scenario: A finished scheduled run

- **WHEN** a scheduled run ends in the state `done`
- **THEN** it appears in the Done column
