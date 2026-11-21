# thread-permission-mode-persistence Specification

## Purpose

TBD - created by archiving change codex-permission-approvals. Update Purpose after archive.

## Requirements

### Requirement: Existing thread permission mode persists immediately

The system SHALL persist a valid permission-mode selection for an existing
thread when its owner changes the selector, without requiring a subsequent
user message. The client SHALL reflect the saved value after navigation or
reload.

#### Scenario: User changes mode and reopens the thread

- **WHEN** a thread owner changes the permission mode and leaves the thread
  without sending a prompt
- **THEN** the stored thread permission mode is updated
- **AND** reopening or reloading the thread displays the chosen mode

#### Scenario: Persistence request fails

- **WHEN** the mode update request fails
- **THEN** the client restores the previously stored mode
- **AND** the client informs the user that the selection was not saved

### Requirement: Mode updates converge across thread views

The system SHALL broadcast a successfully persisted thread permission-mode
change to every loaded view of that thread.

#### Scenario: Same thread is open in multiple views

- **WHEN** a thread owner successfully changes the mode in one view
- **THEN** every loaded view of that thread receives the updated mode
- **AND** a later prompt from any view uses that persisted mode by default

### Requirement: A running agent is not silently reconfigured

The system SHALL apply a persisted mode change to the next agent
execution/resume and SHALL NOT claim that it changed an already-running
agent's sandbox or approval policy.

#### Scenario: User changes mode while the agent is running

- **WHEN** a thread owner changes the permission mode while its agent is
  running
- **THEN** the selection is saved for the next execution/resume
- **AND** the active execution continues under the policy with which it began
