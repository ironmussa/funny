# Spec Delta

## MODIFIED Requirements

### Requirement: Tracked operations are recorded as activities

The system SHALL record one activity for each run of a tracked operation, from the moment it starts.
The tracked operations are:

- operations a user starts that keep going in the background: cloning a repository, setting up a
  worktree for a thread, a git workflow started from the review pane (commit, push, create PR,
  merge) and provisioning a sandbox;
- writes to GitHub a user starts from the review pane: merging a pull request, publishing a
  repository and reverting a file in a pull request;
- git commands a user runs that throw work away: discarding changes, resetting hard to a commit,
  dropping a stash and rewinding a thread's code;
- changes funny makes to a workspace on its own: cleaning up a thread's workspace, removing orphan
  worktree directories, and switching the branch of the user's checkout or stashing its changes;
- actions the server takes on its own: stopping, waking and destroying a sandbox, merging a factory
  pull request and deleting its branch, disabling a factory whose enabler lost access, stopping
  agents because a project's runner binding changed, skipping an automation run because the
  previous one is still running, and leaving an automation unscheduled because its schedule cannot
  be read.

An activity SHALL carry its kind, a title, its status, the project and thread it concerns when there
is one, the time it started and the time it ended.

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

#### Scenario: An action funny takes on its own

- **WHEN** creating a thread switches the branch of the user's checkout
- **THEN** an activity records the switch, naming the branch it left and the branch it checked out

#### Scenario: Pull request merged from the review pane

- **WHEN** a user merges a pull request from the review pane
- **THEN** a user-started activity records the merge with the merged pull request as its effect

#### Scenario: Changes discarded

- **WHEN** a user discards the changes to three files
- **THEN** an activity records the discard, lists the three files and names the undo snapshot

### Requirement: Retry reopens where the activity started

A `failed` or `interrupted` activity SHALL offer a retry when its kind has a place to return to.
Retry SHALL NOT run the operation again by itself: it SHALL open the form the operation was started
from, filled with the recorded input, or, for an operation without a form, the place it was started
from. When that place no longer exists, retry SHALL open the nearest one that does and the activity
SHALL stay listed. An activity whose kind has no such place (an action funny took on its own with
nothing for the user to redo) SHALL offer no retry.

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

#### Scenario: Retry a failed workspace cleanup

- **WHEN** a user chooses retry on a failed workspace cleanup
- **THEN** the worktree settings of the project open, where the leftover worktree can be removed

#### Scenario: Retry an unscheduled automation

- **WHEN** a user chooses retry on an automation left unscheduled because of its schedule
- **THEN** the project's automation settings open on that automation

#### Scenario: Retry a failed pull request merge

- **WHEN** a user chooses retry on a failed pull request merge
- **THEN** the review pane opens on the project's pull requests, and no merge has started

#### Scenario: No place to return to

- **WHEN** a sandbox stop that funny started on its own has failed
- **THEN** the activity is listed as failed without a retry

## ADDED Requirements

### Requirement: Restore from an activity

An activity whose operation saved an undo snapshot SHALL offer a restore while that snapshot
exists. Restoring SHALL ask for confirmation, SHALL put the snapshot back on the runner the
operation ran on, and SHALL be recorded as its own activity. An activity whose snapshot was pruned
or whose runner no longer has it SHALL offer no restore.

#### Scenario: Restore discarded changes

- **WHEN** a user chooses restore on a discard activity and confirms
- **THEN** the discarded changes are back in the working tree and an activity records the restore

#### Scenario: Snapshot pruned

- **WHEN** a discard activity is older than the snapshot retention
- **THEN** the activity is listed without a restore

### Requirement: Repeated automation skips are recorded once

A skipped automation run SHALL be recorded only for the first skip after a run started. Further
skips while that run is still running SHALL NOT add activities.

#### Scenario: Long run over several ticks

- **WHEN** an automation scheduled every minute has a run that lasts ten minutes
- **THEN** one skip activity is recorded for that run, not nine
