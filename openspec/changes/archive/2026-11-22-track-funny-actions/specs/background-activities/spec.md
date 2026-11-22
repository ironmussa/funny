# Spec Delta

## MODIFIED Requirements

### Requirement: Tracked operations are recorded as activities

The system SHALL record one activity for each run of a tracked operation, from the moment it starts.
The tracked operations are:

- operations a user starts that keep going in the background: cloning a repository, setting up a
  worktree for a thread, a git workflow started from the review pane (commit, push, create PR,
  merge) and provisioning a sandbox;
- changes funny makes to a workspace on its own: cleaning up a thread's workspace, removing orphan
  worktree directories, and switching the branch of the user's checkout or stashing its changes;
- actions the server takes on its own: stopping, waking and destroying a sandbox, merging a factory
  pull request and deleting its branch, disabling a factory whose enabler lost access, and stopping
  agents because a project's runner binding changed.

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

#### Scenario: No place to return to

- **WHEN** a sandbox stop that funny started on its own has failed
- **THEN** the activity is listed as failed without a retry

## ADDED Requirements

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
