## ADDED Requirements

### Requirement: Pi provider uses the native Pi SDK

The system SHALL run provider id `pi` through the first-party Pi SDK instead of the ACP adapter and `pi-acp` subprocess.

#### Scenario: Starting a Pi thread creates an SDK session

- **WHEN** a thread starts with provider `pi`
- **THEN** the runtime creates a Pi SDK agent session for the thread cwd and emits an `agent:init` event containing the SDK session id, model, cwd, and visible tools

#### Scenario: Pi no longer requires the ACP binary

- **WHEN** provider `pi` is selected on a runner without `pi-acp` on PATH
- **THEN** the provider start path does not fail because `pi-acp` is missing

### Requirement: Pi SDK events are translated to funny messages

The system SHALL translate Pi SDK session events into funny's existing `CLIMessage` stream without changing the client WebSocket contract.

#### Scenario: Streaming assistant text

- **WHEN** the Pi SDK emits assistant text deltas during a prompt
- **THEN** funny emits assistant text messages that appear in the existing thread message timeline

#### Scenario: Tool execution visibility

- **WHEN** the Pi SDK emits tool execution start, update, and end events
- **THEN** funny emits tool-use and tool-result messages using stable ids so existing tool cards can render them

#### Scenario: Prompt completion

- **WHEN** the Pi SDK reports that the agent finished handling a prompt
- **THEN** funny emits a result message with the SDK session id and success or error status

### Requirement: Pi supports warm follow-up and steering through SDK APIs

The system SHALL map funny follow-up and steering operations for live Pi processes to the corresponding Pi SDK session APIs.

#### Scenario: Follow-up prompt on a live Pi process

- **WHEN** a user sends a follow-up to a live compatible Pi process
- **THEN** funny sends it through the existing Pi SDK session instead of respawning through ACP

#### Scenario: Steering a live Pi process

- **WHEN** a user steers a live Pi process while it is handling a prompt
- **THEN** funny uses the Pi SDK steering behavior and keeps the same provider session where possible

### Requirement: Pi model discovery uses the SDK registry

The system SHALL discover available Pi models through the Pi SDK model registry instead of ACP `session/new` discovery.

#### Scenario: Available models are returned

- **WHEN** the runtime requests Pi models
- **THEN** it returns the models reported by the Pi SDK registry using the existing `{ ok, models, currentModelId }` response shape

#### Scenario: Authentication is missing

- **WHEN** the Pi SDK registry cannot return available models because credentials are missing
- **THEN** the runtime returns a typed failure response compatible with the existing model-picker error handling

### Requirement: Pi session fork and resume use SDK primitives when available

The system SHALL prefer Pi SDK session/runtime APIs for Pi resume and fork operations and SHALL fall back to existing context recovery when a native session operation is unavailable.

#### Scenario: Native Pi fork succeeds

- **WHEN** a Pi thread is forked and the SDK exposes a compatible fork API
- **THEN** funny persists the new SDK session id on the forked thread

#### Scenario: Native Pi fork is unavailable

- **WHEN** a Pi thread is forked and the SDK cannot provide a compatible fork operation
- **THEN** funny creates the forked thread without a native Pi session id and relies on context recovery for the next agent turn
