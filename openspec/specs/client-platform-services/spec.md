# client-platform-services Specification

## Purpose

Defines a stable boundary through which renderer-independent client behavior uses host services while keeping the existing browser and Tauri experience compatible.

## Requirements

### Requirement: Explicit platform contract

Renderer-independent client logic SHALL obtain persistence, navigation, transport configuration, application lifecycle state, and user-facing effects through an explicit platform contract rather than accessing browser or DOM globals.

#### Scenario: Run shared logic without a DOM

- **WHEN** a consumer supplies conforming in-memory platform services in a runtime with no `window`, `document`, `localStorage`, DOM element types, or browser observers
- **THEN** renderer-independent client state and event-processing modules SHALL initialize and execute without requiring those globals

#### Scenario: Missing required service

- **WHEN** the client composition root is initialized without a required platform capability
- **THEN** initialization SHALL fail with an error that identifies the missing capability before client event processing begins

### Requirement: Web and Tauri compatibility

The browser/Tauri platform implementation SHALL preserve the existing persistence keys, route interpretation, same-origin browser transport behavior, localhost Tauri transport behavior, lifecycle reactions, and user-visible effects.

#### Scenario: Browser transport resolution

- **WHEN** the client runs in a regular browser
- **THEN** API requests SHALL continue to use the same-origin API path and the primary realtime connection SHALL use the page origin

#### Scenario: Tauri transport resolution

- **WHEN** the client runs inside the Tauri shell
- **THEN** API and realtime connections SHALL continue to target the configured local server port

#### Scenario: Existing persisted preferences

- **WHEN** the new web platform implementation reads preferences written by the current client
- **THEN** it SHALL resolve the same values without requiring a data migration or changing storage keys

### Requirement: Deterministic storage semantics

The storage capability SHALL support read, write, remove, and subscription behavior without requiring callers to know the host storage mechanism, and SHALL make unavailable or malformed stored values recoverable.

#### Scenario: Storage unavailable

- **WHEN** the host persistence mechanism is unavailable or denies access
- **THEN** client initialization and state updates SHALL continue with non-persistent defaults and SHALL expose the storage failure for diagnostics

#### Scenario: Malformed persisted value

- **WHEN** a persisted value cannot be decoded by its owning state module
- **THEN** that module SHALL use its defined default and MAY remove or replace only the malformed value

#### Scenario: Storage change notification

- **WHEN** a stored value changes through the platform capability
- **THEN** registered consumers SHALL be notified with the affected key and current value

### Requirement: Platform-neutral transport processing

API endpoint selection and realtime event interpretation SHALL be separable from the concrete browser transport and renderer effects so that the same typed server events can update client state in another host.

#### Scenario: Process event with an alternate host

- **WHEN** a conforming non-web host delivers a valid server event to the client event processor
- **THEN** the processor SHALL apply the same renderer-independent state transition as the web client and SHALL emit semantic effects through the platform contract

#### Scenario: Remote thread endpoint

- **WHEN** a thread is assigned a validated remote container origin
- **THEN** transport resolution SHALL preserve the existing remote endpoint selection and origin-validation rules

#### Scenario: Invalid remote origin

- **WHEN** a remote container URL is malformed, contains credentials, uses an unsupported protocol, or violates the configured origin allowlist
- **THEN** the client SHALL reject that origin and SHALL NOT send the request to it

### Requirement: Host lifecycle and semantic effects

Renderer-independent logic SHALL observe route, host-window focus, and visibility changes through host lifecycle services and SHALL request notifications, toasts, and application events as semantic effects rather than invoking renderer APIs directly. Focus transitions among child controls SHALL NOT be reported as host-window lifecycle transitions; when a native runtime cannot observe window focus independently, its platform adapter SHALL preserve an explicit conservative lifecycle state rather than infer window inactivity from child-element blur.

#### Scenario: Resume a visible connected client

- **WHEN** the host reports that the application has regained focus or become visible while realtime transport is connected
- **THEN** the client SHALL apply the existing throttling and route eligibility rules before requesting thread resynchronization

#### Scenario: Move focus between native child controls

- **WHEN** keyboard or pointer interaction moves focus between controls inside the same active native window
- **THEN** the host lifecycle service SHALL NOT report that the application became inactive or invisible

#### Scenario: Native runtime lacks independent window-focus events

- **WHEN** the active native runtime exposes child-element focus but no verified host-window focus signal
- **THEN** the platform adapter SHALL NOT derive host inactivity from child-element blur and SHALL keep the limitation explicit in diagnostics or verification evidence

#### Scenario: Deliver a user-facing effect

- **WHEN** event processing produces a notification, status message, or application event
- **THEN** the active platform implementation SHALL translate that semantic effect into the host-supported presentation without changing the state transition

#### Scenario: Unsupported optional effect

- **WHEN** a host does not support an optional user-facing effect
- **THEN** processing SHALL continue without failure and the unsupported effect SHALL remain observable to diagnostics

### Requirement: Enforced renderer boundary

The repository SHALL automatically reject new direct browser-global, DOM-type, browser-observer, or web-renderer imports from modules designated as renderer-independent.

#### Scenario: Boundary violation in validation

- **WHEN** a renderer-independent module introduces a forbidden browser or DOM dependency
- **THEN** the repository validation command SHALL fail and identify the file and dependency

#### Scenario: Renderer-specific implementation

- **WHEN** a web platform adapter or renderer module uses DOM APIs required to implement its contract
- **THEN** repository validation SHALL allow that dependency within the explicitly designated web boundary

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
