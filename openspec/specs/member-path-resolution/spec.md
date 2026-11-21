# member-path-resolution Specification

## Purpose
TBD - created by archiving change shared-project-directory-assignment. Update Purpose after archive.

## Requirements

### Requirement: Per-user project path resolution

The system SHALL resolve the working directory for thread operations based on the relationship between the current user and the project. If the user is the project owner, the system SHALL use `project.path`. If the user is a member, the system SHALL use the member's `localPath` from `project_members`.

#### Scenario: Owner creates a thread on their project

- **WHEN** the project owner creates a thread on their own project
- **THEN** the system uses `project.path` as the working directory for the agent

#### Scenario: Member creates a thread on a shared project with configured directory

- **WHEN** a member with a configured `localPath` creates a thread on a shared project
- **THEN** the system uses the member's `localPath` as the working directory for the agent

#### Scenario: Member creates a thread on a shared project without configured directory

- **WHEN** a member without a configured `localPath` attempts to create a thread on a shared project
- **THEN** the system SHALL reject the request with a 400 error indicating the directory must be configured first

### Requirement: Path resolution applies to all thread operations

The system SHALL use the resolved per-user path consistently across all thread operations: thread creation, message sending, thread resumption, worktree creation, and branch checkout.

#### Scenario: Member sends a follow-up message on a shared project thread

- **WHEN** a member sends a follow-up message on a thread belonging to a shared project
- **THEN** the system resolves the working directory using the member's `localPath`, not `project.path`

#### Scenario: Worktree creation uses member's local path as base

- **WHEN** a member creates a worktree-mode thread on a shared project
- **THEN** the system creates the worktree branching from the member's `localPath` directory, not `project.path`

### Requirement: Path resolution function returns Result type

The `resolveProjectPath(projectId, userId)` function SHALL return `Result<string, DomainError>` following the codebase's `neverthrow` convention. It SHALL return `ok(path)` on success and `err(DomainError)` on failure.

#### Scenario: Project not found

- **WHEN** `resolveProjectPath` is called with a non-existent project ID
- **THEN** it returns `err` with a "not found" domain error

#### Scenario: Member has no localPath configured

- **WHEN** `resolveProjectPath` is called for a member without a `localPath` in `project_members`
- **THEN** it returns `err` with a "directory not configured" domain error
