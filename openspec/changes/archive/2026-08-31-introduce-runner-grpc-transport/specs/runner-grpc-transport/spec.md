## Purpose

Defines a typed, versioned, recoverable gRPC boundary for every communication between a runner and the central server while preserving safe coexistence with legacy runners during migration.

## ADDED Requirements

### Requirement: Complete native gRPC runner boundary

The system SHALL expose a versioned Protobuf and native gRPC contract for all control commands, runner data operations, agent events, proxied HTTP traffic, and terminal traffic exchanged between a runner and the central server. The runner SHALL initiate every long-lived connection so it can operate behind NAT and outbound-only firewalls.

#### Scenario: Runner establishes the transport

- **WHEN** a compatible runner starts with valid credentials and can reach the central server
- **THEN** it SHALL establish the gRPC transport without requiring an inbound connection to the runner
- **AND** it SHALL exchange its protocol version and supported capabilities before accepting work

#### Scenario: Unsupported protocol version

- **WHEN** a runner offers no protocol version supported by the central server
- **THEN** the server SHALL reject activation with a typed incompatibility status that identifies the supported version range

#### Scenario: All runner traffic uses the selected protocol

- **WHEN** a runner activates using the gRPC protocol
- **THEN** its control, data, agent-event, HTTP-tunnel, and terminal traffic SHALL use gRPC
- **AND** the same runner instance SHALL NOT also publish that traffic through the legacy Socket.IO protocol

### Requirement: Independently flow-controlled communication classes

The transport SHALL isolate control, data operations, agent events, HTTP tunnels, and terminals into independently flow-controlled streams or calls on the same runner channel. Congestion or failure in one class SHALL NOT prevent heartbeats, cancellation, or terminal agent state from being delivered in another class.

#### Scenario: Slow tunnel consumer

- **WHEN** a proxied HTTP response is being consumed more slowly than the runner produces it
- **THEN** tunnel production SHALL be backpressured within configured bounds
- **AND** runner heartbeats and agent terminal events SHALL continue to make progress

#### Scenario: Bounded buffering

- **WHEN** a peer stops consuming a stream and the configured buffer limit is reached
- **THEN** the system SHALL stop accepting unbounded payloads for that stream
- **AND** it SHALL cancel or fail the affected operation with a typed resource-exhausted outcome

### Requirement: Authenticated and authorized runner identity

The server SHALL authenticate the gRPC channel from runner credentials and derive runner, user, and tenant identity from those credentials. Payload-supplied identity SHALL NOT override the authenticated identity, and every operation SHALL be authorized against its referenced resources before execution.

#### Scenario: Payload attempts identity substitution

- **WHEN** an authenticated runner sends a payload containing a different user or tenant identity
- **THEN** the server SHALL ignore that claimed identity or reject the message
- **AND** it SHALL NOT access resources outside the authenticated principal

#### Scenario: Cross-tenant resource reference

- **WHEN** a runner references a thread, project, or other resource outside its authorized tenant or ownership scope
- **THEN** the server SHALL reject the operation without revealing protected resource details

#### Scenario: Revoked credentials

- **WHEN** runner credentials are invalid, expired, or revoked
- **THEN** the server SHALL reject the channel and SHALL NOT activate or dispatch work to the runner

### Requirement: Explicit operation lifecycle

Every operation SHALL have a typed request and outcome, a deadline, and explicit cancellation behavior. The server and runner SHALL enforce configured message-size and concurrency limits and SHALL propagate cancellation to work that is still in progress.

#### Scenario: Operation exceeds its deadline

- **WHEN** an operation does not complete before its declared or server-imposed deadline
- **THEN** the caller SHALL receive a deadline-exceeded outcome
- **AND** the callee SHALL stop associated work when cancellation is supported

#### Scenario: Caller abandons a tunnel

- **WHEN** the caller cancels a tunneled HTTP request before completion
- **THEN** cancellation SHALL propagate to the runner-side request
- **AND** buffered response data for that request SHALL be released

#### Scenario: Oversized message

- **WHEN** a peer sends a message larger than the negotiated or configured maximum
- **THEN** the transport SHALL reject the message with a typed resource-exhausted outcome without terminating unrelated communication classes

### Requirement: Idempotent persistent mutations

Every retryable mutation that can create or modify durable state SHALL carry an idempotency key scoped to the authenticated runner and operation. The runner SHALL retain unconfirmed mutations in a durable outbox, and the server SHALL retain enough deduplication state to return the original outcome when a request is repeated after disconnection.

#### Scenario: Disconnect after mutation execution

- **WHEN** the server commits a mutation but the connection fails before the runner receives its outcome
- **THEN** the runner SHALL retry the mutation with the same idempotency key
- **AND** the server SHALL return the original outcome without applying the mutation a second time

#### Scenario: Runner restarts with pending mutations

- **WHEN** a runner restarts while its durable outbox contains unconfirmed mutations
- **THEN** it SHALL resume delivery after authentication using the original idempotency keys

#### Scenario: Idempotency conflict

- **WHEN** the same idempotency key is reused for a materially different mutation
- **THEN** the server SHALL reject it with a typed conflict outcome and SHALL NOT execute the new payload

### Requirement: Sequenced and resumable agent events

Agent events SHALL be monotonically sequenced within a declared scope and acknowledged at the application level. The runner SHALL retain unacknowledged events within bounded durable or recoverable storage and SHALL resume from the last acknowledged sequence after reconnecting. A terminal result or error SHALL be delivered reliably and SHALL NOT be discarded because non-terminal chunks exhaust their buffer.

#### Scenario: Reconnect within retained history

- **WHEN** a runner reconnects and the receiver requests a sequence still present in retained history
- **THEN** delivery SHALL resume with the next unacknowledged event without duplicating an applied event

#### Scenario: Requested sequence is no longer available

- **WHEN** the receiver requests a sequence older than the retained history
- **THEN** the sender SHALL return an explicit gap containing the earliest available sequence
- **AND** the receiver SHALL resynchronize the affected resource from durable state

#### Scenario: Chunk pressure precedes terminal state

- **WHEN** non-terminal chunks fill their configured buffer and the agent then completes or fails
- **THEN** the terminal result or error SHALL remain deliverable through reserved capacity or a higher-priority path
- **AND** any loss of non-terminal chunks SHALL be reported as an explicit gap

### Requirement: Terminal input is never replayed implicitly

Terminal input SHALL use at-most-once delivery across reconnects, while terminal output SHALL be sequenced and replayable only within a bounded retention window. Resize updates MAY be coalesced so that the latest dimensions supersede older unprocessed dimensions.

#### Scenario: Disconnect after terminal input

- **WHEN** a connection fails after terminal input may have reached the runner
- **THEN** the transport SHALL NOT automatically replay that input after reconnecting

#### Scenario: Terminal output resumes within retention

- **WHEN** a terminal reconnects with a last-seen output sequence still in retained history
- **THEN** the runner SHALL replay subsequent output in order and then continue live delivery

### Requirement: Deterministic runner presence and replacement

The server SHALL maintain at most one active gRPC session for a runner identity. A newly authenticated session SHALL deterministically supersede an older session without allowing the displaced session to mark the replacement offline.

#### Scenario: Replacement connects while stale session remains

- **WHEN** a runner establishes a new authenticated session while an older session with the same identity remains open
- **THEN** the server SHALL activate the new session and close or invalidate the old session
- **AND** cleanup from the old session SHALL NOT mark the new session offline

#### Scenario: Heartbeat expires

- **WHEN** an active runner stops sending valid heartbeats for the configured timeout
- **THEN** the server SHALL mark that session unavailable and stop dispatching new work to it

### Requirement: Compatibility gate before production rollout

The implementation SHALL prove interoperability between the selected central-server runtime and a Rust gRPC client before enabling production runner traffic. The gate SHALL cover prolonged bidirectional streaming, metadata and status trailers, cancellation, deadlines, slow-consumer backpressure, binary payload limits, reconnect behavior, production ingress traversal, and coexistence with the existing application listener.

#### Scenario: Compatibility suite passes

- **WHEN** every required interoperability and ingress test passes under sustained and failure-injected conditions
- **THEN** direct gRPC handling in the central-server runtime MAY proceed to canary rollout

#### Scenario: Direct runtime support fails the gate

- **WHEN** any required behavior cannot be made reliable in the central-server runtime
- **THEN** production rollout SHALL remain disabled
- **AND** the implementation SHALL use a compatible gRPC gateway boundary or stop the change without weakening the protocol requirements

### Requirement: Reversible coexistence and rollout

The server SHALL support legacy Socket.IO runners and gRPC runners concurrently during migration, while each runner uses exactly one selected transport. Protocol-specific health, connection, error, retry, backlog, and latency signals SHALL be observable, and rollout SHALL be reversible without losing accepted durable operations.

#### Scenario: Mixed runner fleet

- **WHEN** legacy and gRPC-capable runners are connected during migration
- **THEN** the server SHALL route work to each runner through its active protocol without duplicate dispatch or duplicate event publication

#### Scenario: Canary rollback

- **WHEN** gRPC canary health violates a configured rollout threshold
- **THEN** operators SHALL be able to stop assigning new gRPC sessions and return eligible runners to the legacy protocol
- **AND** already accepted durable mutations SHALL remain recoverable

#### Scenario: Protocol-level diagnostics

- **WHEN** operators inspect runner transport health
- **THEN** they SHALL be able to distinguish protocol version and observe connection state, reconnects, typed failures, stream backlog, gaps, and end-to-end latency without exposing credentials or payload content

### Requirement: Browser transport remains compatible

This capability SHALL NOT require browsers to speak native gRPC. Existing browser-to-central-server HTTP and realtime interfaces SHALL remain behaviorally compatible while the central server translates browser actions and runner responses across the new boundary.

#### Scenario: Browser controls a gRPC runner

- **WHEN** a browser uses an existing supported API or realtime interaction whose target runner selected gRPC
- **THEN** the user-visible behavior SHALL remain compatible without requiring a native gRPC browser client
