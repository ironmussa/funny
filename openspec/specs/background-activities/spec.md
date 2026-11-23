# background-activities Specification

## Purpose

Records the background operations a user starts (cloning a repository, setting up a worktree,
commit / push / create PR) so that their progress and outcome can be seen from anywhere in the app,
after a reload and in other tabs, and so that a failed one can be retried.

## Requirements

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

### Requirement: Activities record who started them

An activity SHALL carry its origin: `user` when the user asked for that operation, `implicit` when
it followed from another action of the user, and `system` when funny started it on a schedule or
from a background check. The origin SHALL be set by the code that runs the operation and SHALL NOT
be changed afterwards. The panel SHALL label `implicit` and `system` activities as automatic.

#### Scenario: Cleanup that follows an archive

- **WHEN** archiving a thread removes its worktree
- **THEN** the cleanup activity has origin `implicit` and the panel labels it automatic

#### Scenario: Worktree removed from settings

- **WHEN** a user removes a worktree from the worktree settings
- **THEN** the cleanup activity has origin `user` and carries no automatic label

#### Scenario: Idle sandbox stopped

- **WHEN** funny destroys a sandbox that was idle
- **THEN** the activity has origin `system`

### Requirement: Activities list what they changed

A finished activity SHALL list its effects: the things the operation removed, stopped or changed
(a worktree removed, a branch deleted, a command stopped, a terminal closed, a branch checked out,
changes stashed, a sandbox destroyed, a pull request merged, agents stopped), each with the name of
the thing. The list SHALL hold at most 20 effects. A failed activity SHALL list the effects that
happened before the failure. The panel SHALL show the effects of an activity and SHALL mark an
activity whose kind is destructive.

#### Scenario: Effects of a cleanup

- **WHEN** a cleanup stops one command, removes a worktree and deletes a branch
- **THEN** the activity lists those three effects with the command, the directory and the branch

#### Scenario: Partial effects on failure

- **WHEN** a cleanup removes the worktree and then fails to delete the branch
- **THEN** the failed activity lists the removed worktree and not the branch

#### Scenario: More than 20 effects

- **WHEN** an operation reports 30 effects
- **THEN** the activity records 20 of them

### Requirement: Instant actions are recorded finished

An action that completes at once SHALL be recorded as a single activity that is already
`succeeded` or `failed`, with the same start and end time. Such an activity SHALL be accepted only
with a final status and SHALL NOT be changed afterwards.

#### Scenario: Instant success

- **WHEN** funny switches the branch of the user's checkout
- **THEN** one activity appears, already `succeeded`, without having been listed as `running`

#### Scenario: Report after an instant activity

- **WHEN** an activity recorded as `succeeded` in one step receives a later status report
- **THEN** the report is refused and the activity is unchanged

### Requirement: Routine actions are recorded only when they fail

Each kind SHALL declare whether every run is recorded or only failed runs. A successful run of a
kind recorded only on failure SHALL leave no activity. Stopping an idle sandbox and waking a sandbox
SHALL be recorded only on failure. Kinds that are destructive SHALL record every run.

#### Scenario: Sandbox wakes

- **WHEN** a sandbox is woken and comes up
- **THEN** no activity is recorded

#### Scenario: Sandbox fails to wake

- **WHEN** a sandbox cannot be woken
- **THEN** a `failed` activity records it with the error

#### Scenario: Destructive kind

- **WHEN** a worktree is removed successfully
- **THEN** an activity records it

### Requirement: Activities run by the server

The server SHALL record activities for the actions it takes itself. Such an activity SHALL belong
to the user the action was taken for (the owner of the thread, sandbox or project, or the enabler of
the factory), taken from stored state and never from a request's content, and SHALL have no runner.
Only the server SHALL change it. When the server starts, every `running` activity without a runner
SHALL become `interrupted`. A `running` activity without a runner SHALL NOT be dismissed.

#### Scenario: Factory merges a pull request

- **WHEN** the factory merges a pull request and deletes its branch
- **THEN** the factory's enabler has an activity with origin `system` listing the merged pull
  request and the deleted branch

#### Scenario: Agents stopped by a binding change

- **WHEN** a project is pinned to another runner and the agents running on the previous runner are
  stopped
- **THEN** the project's owner has an activity listing the stopped agents

#### Scenario: Server restarts during provisioning

- **WHEN** the server restarts while a sandbox provisioning activity is `running`
- **THEN** the activity becomes `interrupted`

#### Scenario: Runner reports on a server activity

- **WHEN** a runner reports a status for an activity that has no runner
- **THEN** the report is refused and the activity is unchanged

#### Scenario: Dismiss a running server activity

- **WHEN** a user tries to dismiss a `running` activity that has no runner
- **THEN** the activity stays

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

### Requirement: Review pipeline runs are recorded

When a commit starts the project's code-review pipeline, the system SHALL record the run as one
activity of the thread, marked automatic, that shows the stage it is in, lists the commits the
pipeline made, and ends succeeded when the run completes and failed when it is cancelled or fails.

#### Scenario: Review fixes a finding

- **WHEN** a commit triggers the review pipeline and the corrector's fix is committed
- **THEN** the thread's activity for that run lists the fix commit and ends succeeded

#### Scenario: Run cancelled

- **WHEN** a running review pipeline is cancelled
- **THEN** its activity ends failed saying it was cancelled
