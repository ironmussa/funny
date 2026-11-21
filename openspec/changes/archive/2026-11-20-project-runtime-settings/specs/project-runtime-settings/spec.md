# Spec Delta

## Purpose

Each user's thread runtime for a given project — local, worktree, or sandbox (with the
sandbox provider connection and size) — kept per `(project, user)` and defaulting to
local, so the composer and the issue factory know where that person's new threads run.

## ADDED Requirements

### Requirement: Per-user project runtime

The system SHALL store a thread runtime per `(project, user)` with a `mode` of `local`,
`worktree`, or `sandbox`. When `mode` is `sandbox`, the row SHALL also carry the user's
sandbox provider connection and a size; for `local` and `worktree` the connection and
size SHALL be absent or ignored. Each member of a project SHALL set their own runtime
independently, without affecting other members.

#### Scenario: Two members, different runtimes

- **WHEN** member A sets runtime `worktree` and member B sets runtime `sandbox` for the same project
- **THEN** A's new threads start in a worktree and B's start in a sandbox, neither overriding the other

#### Scenario: Sandbox requires a connection

- **WHEN** a user sets `mode` to `sandbox` without naming one of their own provider connections
- **THEN** the save is refused and the runtime is left unchanged

### Requirement: Default runtime is local

When a user has no runtime row for a project, the system SHALL treat their runtime as
`local`. The system SHALL NOT seed a user's runtime from `projects.default_mode` or from
another member's row.

#### Scenario: Unconfigured member

- **WHEN** a member who has never set a runtime opens the composer for a project
- **THEN** the composer starts in `local`, regardless of the project's `default_mode` or any other member's runtime

### Requirement: Runtime is the composer and factory source

The web composer for a new thread, and the issue factory, SHALL read the caller's
runtime row to decide where the thread runs. The system SHALL NOT read
`projects.default_mode` to decide a new thread's runtime.

#### Scenario: Factory runs as the enabler's runtime

- **WHEN** the issue factory starts a thread on a project whose enabler's runtime is `sandbox`
- **THEN** the thread runs in that user's sandbox, using that user's connection, not another member's and not `projects.default_mode`

### Requirement: Ownership scope

The system SHALL scope every runtime read and write to the calling user and refuse a
project the caller cannot access, reporting it as not found. A sandbox connection named
in a runtime SHALL be one the calling user owns.

#### Scenario: Cross-user access refused

- **WHEN** a user requests or writes the runtime for a project they do not have access to
- **THEN** the system responds not-found and makes no change

#### Scenario: Foreign connection refused

- **WHEN** a user sets `mode` to `sandbox` naming a connection owned by another user
- **THEN** the save is refused as not found
