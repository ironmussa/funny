# Spec Delta

## ADDED Requirements

### Requirement: A pipeline corrector's worktree is removed

When the review-fix loop of a git workflow has read a corrector agent's changes, the system SHALL
remove that corrector's worktree and branch and archive its thread, whether or not it made changes.

#### Scenario: Corrector made a fix

- **WHEN** a corrector agent's fix has been read into the patch the loop applies
- **THEN** the corrector's worktree directory no longer exists and its thread is archived

### Requirement: A thread's cleanup removes its rewind checkpoints

Cleaning up a thread's workspace SHALL also remove the rewind checkpoints saved for that thread.

#### Scenario: Thread deleted

- **WHEN** a worktree thread with rewind checkpoints is deleted
- **THEN** none of its checkpoint refs remain in the repository
