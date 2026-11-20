# gpuix-streaming-performance Specification

## Purpose

Keeps native real-time conversations responsive by limiting streaming reconciliation and exposing clear controls for render mode and frame statistics.

## Requirements

### Requirement: Lightweight streaming presentation

The native client SHALL present an assistant message with bounded plain text while that message is marked as streaming, regardless of whether rich rendering is selected. When the same message becomes durable, the client SHALL present it using the currently selected Rich or Fast rendering mode without losing content.

#### Scenario: Rich mode receives streaming fragments

- **WHEN** an assistant message marked as streaming changes while `Rendering: Rich` is selected
- **THEN** the changed row renders bounded plain text and does not invoke rich Markdown or diff presentation

#### Scenario: Streaming message becomes durable

- **WHEN** the final durable assistant message replaces its streaming form
- **THEN** the row renders the complete bounded preview using the currently selected rendering mode

### Requirement: Streaming updates isolate stable controls

The native client SHALL keep the thread header, composer, and permission card stable when a workspace update changes only streaming message content. Those controls MUST still update when their own selected values change.

#### Scenario: Fragment arrives for selected thread

- **WHEN** a streaming delta changes only one assistant message
- **THEN** the transcript and changed message row update without re-rendering the header, composer, or permission card

#### Scenario: Run or permission state changes

- **WHEN** run lifecycle, share access, or permission data changes
- **THEN** the affected header, composer, or permission card updates to reflect the new value

### Requirement: Actionable rendering diagnostics

When diagnostic mode is enabled, the native client SHALL label the current content mode as `Rendering: Rich` or `Rendering: Fast` and SHALL expose a `Reset stats` action that clears the active renderer's accumulated frame statistics. These controls SHALL remain absent during ordinary non-diagnostic launches.

#### Scenario: User changes rendering mode

- **WHEN** the user activates the rendering-mode control
- **THEN** its label changes to identify the newly active mode

#### Scenario: User resets frame statistics

- **WHEN** the user activates `Reset stats`
- **THEN** the active renderer clears its accumulated debug-frame samples and continues collecting new samples

#### Scenario: Diagnostics are disabled

- **WHEN** the native client starts without diagnostic mode
- **THEN** neither the rendering-mode control nor `Reset stats` is shown
