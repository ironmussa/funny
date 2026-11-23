# Spec Delta

## MODIFIED Requirements

### Requirement: Run card

Each board card SHALL show the issue number (linked to the issue when the run's pull request names its repository), the project name, the time since the run's most recent activity, and the pull request link when there is one. Activating a card SHALL open the run's detail panel. The panel SHALL link to the run's implementing thread, or its latest thread when it has no implementing thread.

#### Scenario: Opening a run

- **WHEN** a member activates the card of a run
- **THEN** that run's detail panel opens, and it links to the run's implementing thread

## ADDED Requirements

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
