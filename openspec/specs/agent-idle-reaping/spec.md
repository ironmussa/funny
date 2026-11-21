# agent-idle-reaping Specification

## Purpose

TBD - created by archiving change agent-idle-reaper. Update Purpose after archive.

## Requirements

### Requirement: Agent activity tracking

The system SHALL track, per thread, the timestamp of the most recent agent activity. Activity SHALL be updated when an agent process starts, when it emits a message, when a follow-up is sent on the live process (`sendPrompt`), when the live process is steered (`steerPrompt`), and when a surviving process is adopted after a runtime restart.

#### Scenario: Message emission refreshes activity

- **WHEN** an agent process emits a message for a thread
- **THEN** that thread's last-activity timestamp is set to the current time

#### Scenario: Adopted process is seeded as active

- **WHEN** a surviving agent process is adopted after a runtime restart
- **THEN** that thread's last-activity timestamp is set to the current time so it is not immediately reaped

### Requirement: Idle reaping of quiescent agents

The system SHALL reap (terminate the process tree of) an agent process when ALL of the following hold: the thread's current turn has reached a terminal result, the time since its last activity exceeds the configured idle window, and the agent is not awaiting a user decision such as a permission prompt. A process that is mid-turn or awaiting a permission decision MUST NOT be reaped.

#### Scenario: Completed idle agent is reaped

- **WHEN** a thread's turn has produced a terminal result and no activity has occurred for longer than the configured idle window
- **THEN** the agent process tree for that thread is terminated and removed from the active set

#### Scenario: Mid-turn agent is never reaped

- **WHEN** an agent process is actively producing output for a turn that has not produced a terminal result
- **THEN** the agent process is not reaped regardless of the idle window

#### Scenario: Agent awaiting a permission decision is not reaped

- **WHEN** an agent's turn is paused awaiting a user permission decision and has not produced a terminal result
- **THEN** the agent process is not reaped

### Requirement: Provider-aware reaping policy

Reaping SHALL be provider-aware using a binary classification consistent with the existing cold-path resume policy: the claude SDK provider — whose resume preserves prompt cache — uses a separate idle window that is disabled by default; **every other provider** uses the standard idle window. The classification SHALL key off the claude provider only, so that any current or future non-claude provider (codex, gemini, pi, cursor, opencode, and external/installed ACP providers) is covered without enumerating it.

#### Scenario: Non-claude provider reaped on standard window

- **WHEN** an idle non-claude agent (e.g. codex, pi, or an external ACP provider) exceeds the standard idle window and is turn-terminal
- **THEN** the agent process is reaped

#### Scenario: Newly added provider is covered without code change

- **WHEN** a provider that is not claude is added or installed
- **THEN** its idle agents are subject to the standard reaping window without any change to the reaping policy

#### Scenario: Claude not reaped when its window is disabled

- **WHEN** an idle claude agent exceeds the standard idle window but the claude idle window is disabled
- **THEN** the claude agent process is not reaped

### Requirement: Reaping is non-destructive and resumable

Reaping SHALL NOT clear the persisted session id, SHALL NOT change the thread's status, and SHALL NOT mark the thread as manually stopped. After a reap, the next user message SHALL resume the thread via the existing resume or cold-path context-recovery flow with no loss of conversation correctness.

#### Scenario: Session id preserved after reap

- **WHEN** an agent process is reaped
- **THEN** the thread's persisted session id is unchanged and its status is unchanged

#### Scenario: Follow-up after reap resumes the conversation

- **WHEN** a user sends a message to a thread whose agent was previously reaped
- **THEN** the agent restarts and continues the conversation with full prior context, with no loss of correctness

#### Scenario: Reap is distinguishable from a manual stop

- **WHEN** an agent process is reaped
- **THEN** an `agent:reaped` event is emitted and the thread is not marked as manually stopped nor flagged as failed

### Requirement: Configurable reaping windows

The idle reaper SHALL be configurable via environment variables for the non-claude idle window, the claude idle window (disabled by default), and the sweep interval. A window value of zero SHALL disable reaping for that class.

#### Scenario: Reaping disabled via configuration

- **WHEN** the non-claude idle window is configured to zero
- **THEN** no agent process is reaped for idleness
