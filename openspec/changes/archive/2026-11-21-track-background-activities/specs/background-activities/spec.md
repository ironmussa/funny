# Spec Delta

## Purpose

Records the background operations a user starts (cloning a repository, setting up a worktree,
commit / push / create PR) so that their progress and outcome can be seen from anywhere in the app,
after a reload and in other tabs, and so that a failed one can be retried.

## ADDED Requirements

### Requirement: Tracked operations are recorded as activities

The system SHALL record one activity for each run of a tracked operation, from the moment it starts.
The tracked operations are: cloning a repository, setting up a worktree for a thread, and a git
workflow started from the review pane (commit, push, create PR, merge). An activity SHALL carry its
kind, a title, its status, the project and thread it concerns when there is one, the time it started
and the time it ended.

#### Scenario: Clone starts

- **WHEN** a user starts cloning a repository
- **THEN** an activity of kind clone exists for that user with status `running` and a title naming
  the repository

#### Scenario: Activity survives a reload

- **WHEN** a user starts a clone, reloads the page and opens the activity panel
- **THEN** the panel lists that clone with its current status

#### Scenario: Activity is visible in another tab

- **WHEN** a user starts a git push in one tab and has the app open in a second tab
- **THEN** the second tab lists the push without a reload

### Requirement: Activity status lifecycle

An activity SHALL be in exactly one status: `running`, `succeeded`, `failed` or `interrupted`. It
starts `running`. `succeeded` and `failed` are final. `interrupted` SHALL change only to `succeeded`
or `failed`, when the runner that ran the operation later reports its outcome. A status report that
is not a legal change from the stored status SHALL be refused and SHALL leave the activity unchanged.

#### Scenario: Operation succeeds

- **WHEN** a tracked operation finishes without error
- **THEN** its activity becomes `succeeded`, records the end time and, when the operation produced
  one, a reference to its result (the created project, the pull request URL)

#### Scenario: Operation fails

- **WHEN** a clone fails because the destination directory already exists
- **THEN** its activity becomes `failed` and carries the error message

#### Scenario: Report after a final status

- **WHEN** a `failed` activity receives a report that it succeeded
- **THEN** the report is refused and the activity stays `failed`

### Requirement: Steps and progress

A running activity SHALL show the step it is on when the operation reports steps. The current step
SHALL be part of the recorded activity. A progress percentage, when the operation reports one, SHALL
be shown while the user is connected and is not required to survive a reload.

#### Scenario: Worktree setup changes step

- **WHEN** a worktree setup moves from creating the worktree to running the startup commands
- **THEN** the activity shows the new step, including after a reload

#### Scenario: Clone progress

- **WHEN** a clone reports that it has received 42 % of the objects
- **THEN** a connected user sees 42 % on that activity

### Requirement: Stopped runners do not leave activities running

An activity whose runner stopped before reporting an outcome SHALL become `interrupted`. When a
runner connects, every `running` activity of that runner that the runner does not report as still
in progress SHALL become `interrupted`.

#### Scenario: Runner restarts during a clone

- **WHEN** the runner process restarts while a clone is `running` and then reconnects
- **THEN** the clone's activity becomes `interrupted`

#### Scenario: Connection drops while the operation continues

- **WHEN** the runner loses its connection during a clone, reconnects while the clone is still in
  progress and the clone then finishes
- **THEN** the activity stays `running` through the reconnection and becomes `succeeded`

### Requirement: Activities are private to their user

A user SHALL see only their own activities. A runner SHALL report activities only for the user it
belongs to, and only for a project or thread it is allowed to serve. The user and the runner of an
activity SHALL be taken from the authenticated runner connection, never from the report's content.

#### Scenario: Another user's activities

- **WHEN** user A lists activities
- **THEN** the list contains no activity of user B

#### Scenario: Report names another user

- **WHEN** a runner of user A reports an activity whose content names user B
- **THEN** the activity is recorded for user A

#### Scenario: Report for a project the runner cannot serve

- **WHEN** a runner reports an activity for a project it is not allowed to serve
- **THEN** the report is refused and no activity is recorded

#### Scenario: Update of another user's activity

- **WHEN** a runner of user A reports a status for an activity of user B
- **THEN** the report is refused and the activity is unchanged

### Requirement: Activity input holds no secrets

An activity SHALL record the input the operation was started with, limited to the fields declared
for its kind. It SHALL NOT record tokens, passwords or credentials, including credentials embedded
in a repository URL.

#### Scenario: Clone URL with credentials

- **WHEN** a clone is started from an `https` URL that embeds a user name and a token
- **THEN** the recorded input holds the URL without the user and token

#### Scenario: Undeclared field

- **WHEN** a report carries an input field its kind does not declare
- **THEN** that field is not recorded

### Requirement: Activity panel

The app SHALL show an activity entry point in the sidebar footer that opens a panel with three tabs:
Activity, Jobs and Watchers. The Activity tab SHALL list running activities first, then finished
ones from newest to oldest, each with its title, status, current step or error, and how long ago it
started or ended. The entry point SHALL show the number of running activities and the number of
`failed` or `interrupted` activities that have not been dismissed.

#### Scenario: Failed clone is listed

- **WHEN** a clone failed while the user was on another screen and the user opens the panel
- **THEN** the Activity tab lists the clone as failed with its error message

#### Scenario: Counters

- **WHEN** a user has two running activities and one failed activity
- **THEN** the entry point shows 2 running and 1 failed

#### Scenario: Jobs and watchers keep working

- **WHEN** a user opens the Jobs tab
- **THEN** it lists the user's jobs with the same actions as before this change

### Requirement: Failure notification

The app SHALL show a notification when an activity of the connected user becomes `failed`, naming
the activity and offering to open the activity panel.

#### Scenario: Push fails on another screen

- **WHEN** a push fails while the user is viewing a different thread
- **THEN** a notification says the push failed and offers to open the panel

### Requirement: Activities are kept until cleared

Finished activities SHALL stay until the user removes them. The user SHALL be able to dismiss one
finished activity and to clear all finished activities at once. A `running` activity SHALL NOT be
dismissed while its runner is connected; when its runner is not connected, dismissing it SHALL
remove it. When a user has more than 500 activities, the oldest `succeeded` ones SHALL be deleted
until 500 remain or no `succeeded` one is left; `failed`, `interrupted` and `running` activities
SHALL NOT be deleted automatically.

#### Scenario: Dismiss one

- **WHEN** a user dismisses a failed activity
- **THEN** it disappears from the panel in every tab of that user and the failed counter drops by one

#### Scenario: Clear finished

- **WHEN** a user with one running and three finished activities clears finished activities
- **THEN** the three finished ones are removed and the running one stays

#### Scenario: Dismiss a running activity

- **WHEN** a user tries to dismiss a running activity whose runner is connected
- **THEN** the activity stays

#### Scenario: Cap removes old successes only

- **WHEN** a user has 500 activities, 20 of them failed, and a new activity starts
- **THEN** the oldest succeeded activity is deleted and all 20 failed ones remain

### Requirement: Retry reopens where the activity started

A `failed` or `interrupted` activity SHALL offer a retry. Retry SHALL NOT run the operation again by
itself: it SHALL open the form the operation was started from, filled with the recorded input, or,
for an operation without a form, the place it was started from. When that place no longer exists,
retry SHALL open the nearest one that does and the activity SHALL stay listed.

#### Scenario: Retry a failed clone

- **WHEN** a user chooses retry on a failed clone
- **THEN** the clone form opens with the repository and destination from the failed attempt, and no
  clone has started

#### Scenario: Retry a failed push

- **WHEN** a user chooses retry on a failed push
- **THEN** the push's thread opens with the review pane visible

#### Scenario: Thread was deleted

- **WHEN** a user chooses retry on a failed push whose thread has been deleted
- **THEN** the thread's project opens and the activity remains in the panel
