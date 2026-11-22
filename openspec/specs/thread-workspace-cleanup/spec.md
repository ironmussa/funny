# thread-workspace-cleanup Specification

## Purpose

Defines what funny does with a thread's worktree, branch and running processes when the thread is
archived, deleted or merged, and what the user is told when that cleanup cannot be completed.

## Requirements

### Requirement: Archiving a worktree thread removes its workspace

When a user archives a thread that runs in a worktree funny created, the system SHALL remove that
worktree and delete the thread's branch on the runner the thread runs on. The thread SHALL be
archived whether or not the removal succeeds. After a successful removal the thread SHALL no longer
name a worktree or a branch. A thread that does not run in a worktree, a scratch thread and a thread
of an external provider SHALL be archived without removing anything.

#### Scenario: Archive a worktree thread

- **WHEN** a user archives a worktree thread whose runner is connected
- **THEN** the thread is archived, its worktree directory no longer exists and its branch is deleted

#### Scenario: Archive a local thread

- **WHEN** a user archives a thread that runs in the project directory
- **THEN** the thread is archived and no directory or branch is removed

#### Scenario: Removal fails

- **WHEN** a user archives a worktree thread and the worktree cannot be removed
- **THEN** the thread is archived, it still names its worktree and branch, and the user is told the
  cleanup failed

### Requirement: Deleting a thread removes its workspace

When a user deletes a worktree thread, the system SHALL remove its worktree and SHALL delete its
branch when the user chose to delete the branch. When a user deletes a scratch thread, the system
SHALL remove the thread's scratch directory. The thread SHALL be deleted without waiting for the
removal to finish.

#### Scenario: Delete a worktree thread and its branch

- **WHEN** a user deletes a worktree thread and chooses to delete the branch
- **THEN** the thread disappears at once, and its worktree and branch are removed

#### Scenario: Delete a worktree thread and keep the branch

- **WHEN** a user deletes a worktree thread and chooses to keep the branch
- **THEN** the worktree is removed and the branch still exists

#### Scenario: Delete a scratch thread

- **WHEN** a user deletes a scratch thread
- **THEN** its scratch directory no longer exists

### Requirement: Processes are stopped before a workspace is removed

Before removing a worktree for any reason (thread archived, thread deleted, branch merged, a factory
pull request merged, a pipeline's review finished, the user removed it from the worktree settings),
the system SHALL stop the commands and close the terminals running inside that worktree.

#### Scenario: Startup command is running

- **WHEN** a worktree thread with a running startup command is archived
- **THEN** the command is stopped before the worktree is removed

#### Scenario: Terminal is open after a merge

- **WHEN** a thread's branch is merged with cleanup while a terminal is open in its worktree
- **THEN** the terminal is closed and the worktree is removed

### Requirement: Only the thread's own workspace is removed

The system SHALL remove a worktree only when it is a worktree of the thread's project on the
thread's runner, and SHALL never remove the project's main checkout. A cleanup that names any other
directory SHALL be refused and SHALL remove nothing.

#### Scenario: Path outside the project's worktrees

- **WHEN** a cleanup names a directory that is not a worktree of the thread's project
- **THEN** the cleanup is refused and the directory is untouched

#### Scenario: Main checkout

- **WHEN** a cleanup names the project's main checkout
- **THEN** the cleanup is refused and the directory is untouched

### Requirement: A cleanup the runner cannot do is reported

When the thread's runner is not connected, archiving or deleting the thread SHALL still succeed, the
worktree and branch SHALL be left as they are, and the user SHALL be told that the workspace was not
removed and where it is. The system SHALL NOT ask another runner to remove it.

#### Scenario: Runner offline on archive

- **WHEN** a user archives a worktree thread while its runner is offline
- **THEN** the thread is archived and a failed cleanup names the worktree left on disk

#### Scenario: Another runner is online

- **WHEN** a user deletes a worktree thread while its runner is offline and another runner of the
  same user is online
- **THEN** no request is sent to the other runner

### Requirement: Workspace cleanup is recorded

Every workspace cleanup SHALL be recorded as an activity that says why it ran (thread archived,
thread deleted, branch merged, factory pull request merged, review finished, removed by the user,
failed setup undone) and lists what it removed and stopped. A cleanup that could not delete the
branch SHALL be recorded as failed even when the worktree was removed.

#### Scenario: Recorded after archive

- **WHEN** a user archives a worktree thread and opens the activity panel
- **THEN** the panel lists the cleanup of that thread as automatic, with the removed worktree and
  the deleted branch

#### Scenario: Branch cannot be deleted

- **WHEN** a cleanup removes the worktree and the branch deletion fails
- **THEN** the cleanup is listed as failed, shows the removed worktree and carries the branch error
