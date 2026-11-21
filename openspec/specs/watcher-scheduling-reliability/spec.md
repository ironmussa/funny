# watcher-scheduling-reliability Specification

## Purpose
TBD - created by archiving change agent-watchers. Update Purpose after archive.

## Requirements

### Requirement: funny_watch is always available on every agent spawn

The system SHALL inject the `funny_watch` tool into every agent spawn so it is always callable, without depending on per-project user configuration. The tool SHALL be exposed as an in-process MCP tool for the Claude SDK path and as an external MCP server for other providers, both backed by one shared handler.

#### Scenario: Tool is present without user configuration

- **WHEN** an agent is spawned for any thread
- **THEN** `funny_watch` is available to call
- **AND** its availability does not depend on the user having configured an MCP server

### Requirement: Scheduling is decided from the structured tool-call signal, not prose

The system SHALL determine whether an agent scheduled a watcher in a turn by detecting the presence of a `funny_watch` tool call (a structured `tool_use` event) in that turn, and SHALL NOT decide this from the agent's message text. This prevents creating a duplicate watcher when the agent both calls the tool and narrates having done so.

#### Scenario: Tool call present — no further action

- **WHEN** a turn contains a `funny_watch` tool call
- **THEN** the system treats the wake as scheduled and takes no reliability action, regardless of what the message text says

#### Scenario: Message text alone never counts as scheduling

- **WHEN** a turn's message text claims a check was scheduled but contains no `funny_watch` tool call
- **THEN** the system does not treat the wake as scheduled

### Requirement: Non-creating nudge when a deferred-check intent is unscheduled

The system SHALL, only when a completing turn contains no `funny_watch` tool call, evaluate whether the agent expressed an intent to check back later, and if so re-prompt the agent. The re-prompt MUST constrain the agent to either call `funny_watch` or explicitly conclude. The reliability mechanism MUST NOT create or modify a watcher itself.

#### Scenario: Unscheduled deferred intent triggers a constrained re-prompt

- **WHEN** a turn ends with no `funny_watch` tool call but the agent expressed intent to check back later
- **THEN** the system re-prompts the agent constrained to `funny_watch` or an explicit conclusion
- **AND** creates no watcher on its own

#### Scenario: Concluded turn is left alone

- **WHEN** a turn ends with no `funny_watch` tool call and no deferred-check intent
- **THEN** the system takes no reliability action

#### Scenario: Re-prompt false positive is bounded

- **WHEN** the intent evaluation incorrectly flags a turn that had no real deferred-check intent
- **THEN** the only effect is one redundant re-prompt
- **AND** no watcher is created
