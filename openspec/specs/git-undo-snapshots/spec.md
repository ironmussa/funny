# git-undo-snapshots Specification

## Purpose

Defines what funny saves before a git command that throws work away, so the user can get it back
from the activity panel.

## Requirements

### Requirement: A snapshot is saved before destructive git commands

Before discarding changes, resetting hard to a commit, dropping a stash or rewinding a thread's
code, the runner SHALL save an undo snapshot of what the command is about to remove: the working
tree including untracked files that are not ignored, the index and the current `HEAD`, or, for a
dropped stash, the stash itself. When the snapshot cannot be saved, the command SHALL NOT run and
the user SHALL be told why.

#### Scenario: Discard uncommitted work

- **WHEN** a user discards the changes to a tracked file and deletes an untracked file through
  discard
- **THEN** a snapshot holds both files as they were before the discard

#### Scenario: Reset hard

- **WHEN** a user resets a checkout with uncommitted changes hard to an older commit
- **THEN** a snapshot holds the previous `HEAD` and the uncommitted changes

#### Scenario: Snapshot cannot be saved

- **WHEN** the snapshot fails (for example, the repository is locked)
- **THEN** the destructive command does not run and the user sees the error

### Requirement: Snapshots are private to the repository and its owner

A snapshot SHALL be stored as a git ref under a funny-private namespace of the repository it was
taken from, named by the activity it belongs to. It SHALL never be pushed, and SHALL be restored
only on that repository, by the user who owns the activity.

#### Scenario: Push does not carry snapshots

- **WHEN** a user pushes a branch after a discard
- **THEN** the remote receives no snapshot ref

#### Scenario: Another user's activity

- **WHEN** a user asks to restore a snapshot of an activity they do not own
- **THEN** the request is refused and nothing changes

### Requirement: Restoring a snapshot can itself be undone

Restoring a snapshot SHALL first save the current state as a new snapshot, then put the snapshot
back: the working tree and index for a discard, reset or rewind, the stash entry for a dropped stash.
Restoring SHALL NOT move a branch that is not the checked-out one.

#### Scenario: Restore over newer edits

- **WHEN** a user edits a file after a discard and then restores the discard's snapshot
- **THEN** the snapshot's files are back and the newer edits are in a new snapshot named by the
  restore activity

#### Scenario: Restore a dropped stash

- **WHEN** a user restores a dropped stash
- **THEN** the stash list contains that stash again

### Requirement: Snapshots are pruned

Snapshots older than 30 days SHALL be removed from the repository the next time a snapshot is saved
there. A pruned snapshot SHALL no longer be offered for restore.

#### Scenario: Old snapshot

- **WHEN** a snapshot was saved 31 days ago and a new destructive command runs in that repository
- **THEN** the old snapshot ref no longer exists

### Requirement: Rewind checkpoints are pruned

Rewind checkpoints SHALL record when they were saved, and checkpoints older than 30 days SHALL be
removed the next time a checkpoint is saved in that repository. Checkpoints saved before they
recorded a date SHALL be kept until their thread's workspace is cleaned up.

#### Scenario: Old checkpoint

- **WHEN** a checkpoint was saved 31 days ago and a new agent turn starts in that repository
- **THEN** the old checkpoint no longer exists and rewind to that turn is not offered

#### Scenario: Recent checkpoint

- **WHEN** a checkpoint was saved yesterday
- **THEN** it can still be restored
