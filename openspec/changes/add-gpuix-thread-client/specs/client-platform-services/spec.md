## ADDED Requirements

### Requirement: Native GPUIX platform composition

The client platform boundary SHALL support a native GPUIX host that supplies persistence, navigation, authenticated HTTP transport, application lifecycle, semantic effects, and diagnostics without `window`, `document`, browser storage, or DOM event APIs.

#### Scenario: Initialize native composition

- **WHEN** the GPUIX entry point constructs a complete native platform implementation
- **THEN** shared client logic SHALL initialize through the existing platform validation and SHALL operate without browser globals

#### Scenario: Missing native capability

- **WHEN** the GPUIX composition omits a required platform service
- **THEN** startup SHALL fail before authentication or realtime processing and SHALL identify the missing capability

### Requirement: Native transport compatibility

The native transport SHALL preserve the existing endpoint-selection, cancellation, authentication, remote-origin validation, and error semantics used by renderer-independent API and realtime processing.

#### Scenario: Authenticated native request

- **WHEN** shared client logic issues an authenticated API request through the native platform
- **THEN** the transport SHALL target the configured Funny server, attach the current session according to the server contract, and return the same normalized response shape used by other hosts

#### Scenario: Native remote thread request

- **WHEN** a thread is assigned an allowed remote container origin
- **THEN** the native transport SHALL apply the same allowlist and credential protections before sending the request

#### Scenario: Cancel native request

- **WHEN** a renderer-independent operation cancels an in-flight request
- **THEN** the native transport SHALL abort the underlying operation and SHALL NOT apply a late response to client state

### Requirement: Native persistence isolation

The native storage service SHALL persist renderer-neutral preferences and session material using host-appropriate storage while keeping incompatible, malformed, and sensitive values isolated.

#### Scenario: Read compatible preference

- **WHEN** a renderer-neutral preference has a valid native persisted value
- **THEN** shared state SHALL restore it using the same logical key and decoding rules as the web client

#### Scenario: Sensitive session material

- **WHEN** native authentication produces reusable session material
- **THEN** the platform SHALL store only the required session material with user-only access and SHALL never persist the submitted plaintext password

#### Scenario: Storage failure

- **WHEN** native persistence is unavailable or rejects an operation
- **THEN** non-sensitive client state SHALL continue with defaults and the failure SHALL be emitted through diagnostics without exposing secret values

### Requirement: Native lifecycle and effects

The native platform SHALL translate GPUIX window lifecycle changes and supported semantic effects into the existing renderer-neutral lifecycle and effect contracts.

#### Scenario: Regain native focus

- **WHEN** the GPUIX window becomes focused or visible after being inactive
- **THEN** shared realtime recovery SHALL apply the same throttling and route-eligibility rules used by other hosts

#### Scenario: Present semantic effect

- **WHEN** shared processing emits a toast, notification, or application event
- **THEN** the native platform SHALL present the supported effect or record a structured unsupported-effect diagnostic without changing the underlying state transition
