# Spec Delta

## Purpose

A per-project, per-user automation that watches a repository's GitHub issues for a label
and runs a deterministic multi-step flow — implement, checks, PR, wait for CI, merge — to
completion, as the enabling user on their own runtime, with a visible run per issue and
operator controls.

## ADDED Requirements

### Requirement: Per-project factory toggle

The system SHALL let a project member turn a factory on or off for a project, storing the
settings per `(project, user)`: the watched issue label, the flow name, and the maximum
number of issues in flight at once. While off, the factory SHALL NOT admit new issues.
Turning it off SHALL NOT abort runs already in flight; they run to completion.

#### Scenario: Enable starts watching

- **WHEN** a member turns the factory on for a project with label `ready-for-agent`
- **THEN** the system begins admitting that repo's open issues carrying that label, up to the configured concurrency

#### Scenario: Disable stops admission only

- **WHEN** a member turns the factory off while two runs are in flight
- **THEN** no new issues are admitted, and the two in-flight runs continue to completion

### Requirement: Issue trigger admits labelled issues once

The system SHALL poll the watched repository's open issues through a repository-scoped
GitHub App token and start at most one flow run per issue. An issue already having a run
in a non-terminal state SHALL NOT be admitted again. Admission SHALL respect the
configured concurrency limit.

#### Scenario: One run per issue

- **WHEN** an issue already has a running flow and the poller sees it again
- **THEN** no second run is started for that issue

#### Scenario: Concurrency cap

- **WHEN** the concurrency limit is 2 and three labelled issues are open
- **THEN** at most two runs are in flight and the third waits

### Requirement: Flow runs as the enabler on their runtime

Each flow run SHALL execute as the user who enabled the factory, on that user's runtime
for the project — resolved from their `project_runtime_settings` row (local, worktree, or
sandbox with their connection), defaulting to local when absent. The system SHALL NOT run
a factory flow on another user's runner, and SHALL NOT fall back to a different runtime.

#### Scenario: Sandbox enabler

- **WHEN** the enabler's runtime for the project is sandbox and a run starts
- **THEN** the run's threads execute in that user's sandbox, using their connection, not another member's and not the project default_mode

#### Scenario: Enabler runner offline (local/worktree)

- **WHEN** the enabler's runtime is local or worktree and their runner is offline
- **THEN** the run does not start, and the factory reports the issue as waiting for the runner rather than routing elsewhere

### Requirement: Deterministic flow from the default branch

The flow SHALL be read from the repository's default branch, never from a pull request's
branch. A flow SHALL be a sequence of steps of two kinds: thread steps (an agent run with
a profile) and action steps (checks, commit, push, open PR, wait for CI, merge, request
approval). How far a run goes SHALL be decided by the flow's steps, not by a separate
setting.

#### Scenario: PR branch cannot change the flow

- **WHEN** a pull request branch adds a `merge` step to the flow file
- **THEN** the run ignores it and uses the flow from the default branch

### Requirement: A run is visible and controllable

The system SHALL record a run per issue with its current step and outcome, and link each
thread step to its thread. A member SHALL be able to pause the factory, stop a single run,
retry a failed step, and take over a run by sending a follow-up to its thread. The factory
SHALL surface when a run is waiting for the member.

#### Scenario: Take over a run

- **WHEN** a member sends a follow-up to a run's implementation thread
- **THEN** the run continues from that step with the member's input

#### Scenario: Waiting for the member

- **WHEN** a run's CI fails more times than the flow allows
- **THEN** the run is marked as waiting for the member and surfaced as such

### Requirement: The factory turns itself off on lost access

The system SHALL disable a factory when the user who enabled it loses access to the
project or deletes their account. Another member MAY re-enable it in their own name.

#### Scenario: Enabler loses access

- **WHEN** the enabling user is removed from the project
- **THEN** the factory is disabled and admits no further issues until re-enabled by another member
