# agent-sdk-compatibility Specification

## Purpose
Defines the compatibility guarantees Funny provides when translating provider-neutral agent settings into the built-in Claude and Codex SDK adapters.

## Requirements

### Requirement: Supported reasoning effort is preserved

The system SHALL forward a supported reasoning-effort selection to the Codex provider without silently reducing it to a lower supported level.

#### Scenario: Maximum effort is requested

- **WHEN** a Codex agent run is configured with reasoning effort `max`
- **THEN** the Codex SDK receives the native `max` reasoning-effort value

#### Scenario: Existing effort is requested

- **WHEN** a Codex agent run is configured with `low`, `medium`, `high`, or `xhigh`
- **THEN** the Codex SDK receives the corresponding native reasoning-effort value

### Requirement: Provider adapters remain compatible after SDK updates

The system SHALL continue to create and run built-in Claude and Codex sessions using the updated SDK releases without changing Funny's provider-neutral agent process contract.

#### Scenario: Updated provider starts a session

- **WHEN** Funny starts a built-in Claude or Codex session using the updated dependency
- **THEN** the adapter emits events through the existing agent process interface
