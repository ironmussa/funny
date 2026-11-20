# Spec Delta

## Purpose

Keeps the code produced in a sandbox thread safe in the project's git remote, so it survives the sandbox being stopped, lost or destroyed.

## ADDED Requirements

### Requirement: Thread branch

Each sandbox thread SHALL work on its own branch `funny/<threadId>` created from the selected base commit and pushed to `origin` during bootstrap.

#### Scenario: Branch created

- **WHEN** a sandbox thread is bootstrapped
- **THEN** branch `funny/<threadId>` exists on the remote at the base commit

### Requirement: Checkpoint after each turn

After every agent turn that changed tracked or new non-ignored files, the system SHALL create a checkpoint commit on the thread branch and push it. Ignored files, files matching secret patterns (e.g. `.env*`, keys) and files above a size limit SHALL NOT be committed. A turn without changes SHALL NOT create a commit.

#### Scenario: Turn with changes

- **WHEN** a turn finishes having modified files
- **THEN** a checkpoint commit is pushed to `origin funny/<threadId>`

#### Scenario: Secret file excluded

- **WHEN** a turn creates `.env.local` that is not ignored by git
- **THEN** it is not included in the checkpoint and the user is warned

### Requirement: Backup status and stop gating

Each sandbox thread SHALL expose its backup status (`synced`, `pending`, `failed`). A failed push SHALL be retried and shown as "backup pending". The sandbox SHALL NOT be stopped by idle stop while backup is pending or failed.

#### Scenario: Push fails

- **WHEN** pushing a checkpoint fails
- **THEN** the thread shows "backup pending", the push is retried, and the sandbox stays running

### Requirement: Delivery as pull request

The user SHALL be able to open a pull request from the thread branch to its base branch; checkpoint commits SHALL be squashable at merge time.

#### Scenario: Open PR

- **WHEN** the user opens a PR from a sandbox thread
- **THEN** a PR from `funny/<threadId>` to the base branch is created using the user's git credential
