# browser-v1-transport Specification

## Purpose

Defines a browser-compatible, typed, versioned, recoverable communication contract between Funny clients and the central server while retaining Socket.IO for web delivery and allowing native transports to reuse the same schemas.

## Requirements

### Requirement: Isolated versioned client contract

The system SHALL expose client-facing operation, event, presence, terminal, and browser-session schemas under a versioned `browser.v1` Protobuf contract. The contract SHALL NOT expose runner credentials, runner enrollment operations, or privileged `runner.v2` methods, and incompatible future behavior SHALL use a new protocol version.

#### Scenario: Compatible web client connects

- **WHEN** a web client and server support a common `browser.v1` version
- **THEN** the server SHALL activate the versioned binary carrier and expose only operations authorized for the authenticated client principal

#### Scenario: Unsupported protocol version

- **WHEN** a client and server have no mutually supported protocol version
- **THEN** the server SHALL reject protocol activation with a typed incompatibility outcome identifying the supported version range

#### Scenario: Client attempts runner operation

- **WHEN** a client requests an operation that exists only in the runner contract
- **THEN** the server SHALL reject it without forwarding the request or revealing runner credentials

### Requirement: Socket.IO binary carrier for web clients

Web clients SHALL exchange `browser.v1` envelopes as binary Protobuf payloads over the existing authenticated Socket.IO connection. The carrier SHALL preserve Socket.IO reconnection, rooms, acknowledgements, timeout, and supported transport-fallback behavior and SHALL NOT require a second realtime endpoint or separately managed proxy.

#### Scenario: Web client sends a typed envelope

- **WHEN** the web client emits a valid `browser.v1` binary payload through a versioned carrier event
- **THEN** the server SHALL decode and validate the envelope before dispatching its typed operation or interactive message

#### Scenario: Server publishes to a scoped room

- **WHEN** an authorized event targets a user, thread stream, or thread-presence scope
- **THEN** the server SHALL encode one `browser.v1` envelope and publish it through the corresponding existing Socket.IO room semantics

#### Scenario: Binary envelope is malformed

- **WHEN** a carrier payload cannot be decoded, exceeds its configured limit, or violates the negotiated schema
- **THEN** the server SHALL reject it with a safe typed protocol outcome and SHALL NOT dispatch a partial payload

#### Scenario: WebSocket upgrade is unavailable

- **WHEN** a supported deployment falls back from WebSocket to Socket.IO's supported polling transport
- **THEN** the versioned carrier SHALL preserve compatible application behavior within the configured binary payload and latency limits

### Requirement: Transport-neutral native compatibility

The `browser.v1` message and service model SHALL remain independent of Socket.IO packet internals so a supported native client MAY exchange the same typed operations and streams over native gRPC without changing their application semantics or authorization boundary.

#### Scenario: Native client uses browser.v1

- **WHEN** an approved native client and server pass their gRPC compatibility gate
- **THEN** the client SHALL use generated `browser.v1` messages and observe outcomes equivalent to the corresponding authorized web operation

#### Scenario: Native gRPC is unavailable

- **WHEN** a native runtime, package, or ingress does not pass the required compatibility gate
- **THEN** native gRPC assignment SHALL remain disabled without weakening or removing the supported web Socket.IO carrier

### Requirement: Typed operation lifecycle and correlation

Every request-response client operation SHALL have generated request and outcome types, a stable request identifier, a bounded timeout or deadline, and explicit cancellation behavior where downstream work is cancellable. Retryable durable mutations SHALL accept an idempotency key, and outcomes that also produce events SHALL expose correlation or revision metadata sufficient to avoid duplicate state application.

#### Scenario: Socket.IO acknowledgement succeeds

- **WHEN** a web operation completes within its configured acknowledgement timeout
- **THEN** the server SHALL return a typed binary outcome correlated to the request

#### Scenario: Operation exceeds its timeout

- **WHEN** an operation does not complete before its declared or server-imposed bound
- **THEN** the client SHALL receive a typed timeout or deadline outcome and cancellable downstream work SHALL be stopped

#### Scenario: Mutation outcome is lost during disconnect

- **WHEN** a durable mutation commits but its outcome is lost before the client receives it
- **THEN** retrying with the same idempotency key SHALL return the original compatible outcome without applying the mutation twice

#### Scenario: Operation result is also published as an event

- **WHEN** an operation changes state and that change is delivered through the realtime event path
- **THEN** its outcome and event SHALL contain stable causal, entity, or revision metadata that lets the client reconcile them once

### Requirement: Sequenced event recovery

Application events SHALL carry a stable event identifier and ordering metadata within a declared scope. After a disconnect, the client SHALL either resume from an accepted cursor or receive an explicit instruction to rebuild affected state from an authoritative snapshot; duplicate delivery SHALL be safe to ignore.

#### Scenario: Client resumes within retained history

- **WHEN** a reconnecting client supplies a cursor still available to the server
- **THEN** the server SHALL deliver subsequent events in scope order and the client SHALL deduplicate repeated event identifiers

#### Scenario: Client cursor is unavailable

- **WHEN** a requested cursor is absent, expired, or older than retained history
- **THEN** the server SHALL report an explicit gap or snapshot-required outcome and identify the state scopes requiring resynchronization

#### Scenario: Ephemeral state reconnects

- **WHEN** presence, current runner status, or another non-replayable state is interrupted by a disconnect
- **THEN** the server SHALL provide or trigger a current snapshot rather than replay stale transient deltas

### Requirement: Explicit delivery classes and bounded buffering

Every interactive or event payload type SHALL declare whether it is durable, recoverable from snapshot, coalescible, volatile, or at-most-once. The client and server SHALL enforce configured per-connection and per-class message, byte, and concurrency bounds and SHALL NOT allow disconnected or slow consumers to create unbounded application queues.

#### Scenario: Terminal input may have been delivered

- **WHEN** a connection fails after terminal input may have reached the server or runner
- **THEN** the client SHALL NOT implicitly replay that input after reconnecting

#### Scenario: Resize or frame updates accumulate

- **WHEN** multiple unprocessed latest-state updates target the same terminal or browser session
- **THEN** the sender SHALL coalesce them or use volatile delivery while preserving the most recent required state

#### Scenario: Queue limit is reached

- **WHEN** a producer reaches the configured queue or byte limit for a disconnected or slow consumer
- **THEN** the system SHALL reject, coalesce, drop only messages declared droppable, or terminate the affected operation with an observable resource-exhausted outcome

#### Scenario: Terminal outcome follows output pressure

- **WHEN** terminal output reaches its configured buffer limit before the terminal exits or errors
- **THEN** the exit or error SHALL remain deliverable through reserved capacity or a higher-priority carrier event

### Requirement: Authenticated and authorized client identity

Every Socket.IO connection, carrier envelope, and optional native call SHALL authenticate from a server-recognized user session or native credential, validate the request origin where applicable, and authorize each referenced resource. Payload-supplied identity SHALL NOT override authenticated identity or resource authorization.

#### Scenario: Same-origin authenticated web client connects

- **WHEN** a web client presents a valid session cookie from an allowed origin
- **THEN** the server SHALL derive identity from that session and authorize subsequent envelopes against it

#### Scenario: Session is missing or revoked

- **WHEN** a connection has no valid session or its session is revoked
- **THEN** the server SHALL reject or terminate it and SHALL NOT deliver protected events

#### Scenario: Payload attempts identity substitution

- **WHEN** an authenticated client supplies an identity or resource reference outside its authorized scope
- **THEN** the server SHALL ignore the substituted identity or reject the operation without revealing protected resource details

### Requirement: Existing deployment and endpoint behavior remains supported

The web carrier SHALL use Funny's existing Socket.IO origin, namespace, and deployment unit, and SHALL preserve configured local-server endpoint resolution for packaged clients. The capability SHALL NOT require an end user to install or configure Envoy, another proxy, or an additional realtime service.

#### Scenario: Local installation starts

- **WHEN** a user starts Funny through the supported local single-command workflow
- **THEN** the `browser.v1` carrier SHALL be available through the existing server without another managed process

#### Scenario: Regular browser resolves endpoints

- **WHEN** the client runs in a regular browser
- **THEN** it SHALL resolve Socket.IO against the page origin and preserve same-origin session behavior

#### Scenario: Packaged client resolves endpoints

- **WHEN** the client runs in a supported packaged host
- **THEN** it SHALL resolve the selected client transport through the configured local-server policy rather than assuming the page origin

### Requirement: Reversible event-by-event migration and compatibility gate

Legacy Socket.IO events and the versioned binary carrier SHALL coexist during migration while each logical operation or event type for a client is dispatched through one selected representation. Production migration SHALL require protocol-fixture, browser, fallback-transport, reconnect, authorization, message-limit, slow-consumer, and state-parity validation plus observable protocol health.

#### Scenario: Event type is assigned to browser.v1

- **WHEN** rollout policy selects the binary representation for a supported client and logical event type
- **THEN** the server SHALL prevent duplicate publication of that logical event through its legacy representation to the same client

#### Scenario: Compatibility gate fails

- **WHEN** binary parsing, generated-code compatibility, polling fallback, browser packaging, or ingress behavior fails a required gate
- **THEN** migration of the affected event types SHALL remain disabled and their legacy Socket.IO representation SHALL remain available

#### Scenario: Canary health regresses

- **WHEN** decode failures, reconnects, gaps, dropped messages, acknowledgement timeouts, latency, or memory exceed configured thresholds
- **THEN** operators SHALL be able to return new clients to legacy event representations without losing committed durable state

#### Scenario: Operator inspects protocol health

- **WHEN** operators inspect client transport diagnostics
- **THEN** they SHALL be able to distinguish protocol version and representation and observe connections, fallbacks, reconnects, decode failures, timeouts, queue pressure, gaps, payload sizes, and end-to-end latency without exposing credentials or payload content
