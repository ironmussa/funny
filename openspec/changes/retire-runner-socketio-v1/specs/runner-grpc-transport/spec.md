## ADDED Requirements

### Requirement: gRPC-only runner transport

Every runner-to-central-server control command, data operation, agent event, proxied HTTP request, and terminal interaction SHALL use the authenticated gRPC transport. Runner team mode SHALL require a gRPC endpoint and SHALL fail explicitly when it is missing or unavailable instead of selecting runner Socket.IO or direct runner HTTP as a fallback.

#### Scenario: Runner starts without a gRPC endpoint

- **WHEN** team mode is enabled but no runner gRPC endpoint is configured
- **THEN** the runner SHALL report a configuration error and SHALL NOT connect through the legacy runner Socket.IO namespace

#### Scenario: Active gRPC transport disconnects

- **WHEN** an active runner gRPC session disconnects or receives a retryable transport failure
- **THEN** the runner SHALL use the gRPC transport's bounded reconnection behavior
- **AND** it SHALL NOT switch to runner Socket.IO or direct HTTP

#### Scenario: Browser targets a runner

- **WHEN** a browser sends a supported terminal, session, data, event, or tunneled HTTP operation to a runner
- **THEN** the central server SHALL dispatch the runner-facing portion through the active gRPC session
- **AND** browser-facing Socket.IO and HTTP behavior SHALL remain compatible

## MODIFIED Requirements

### Requirement: Idempotent persistent mutations

Every retryable mutation that can create or modify durable state SHALL carry an idempotency key scoped to the authenticated runner and operation. The runner SHALL retain unconfirmed mutations in a durable outbox, and the server SHALL retain a serializable outcome for every accepted mutation so it can return the original outcome when a request is repeated after disconnection.

#### Scenario: Disconnect after mutation execution

- **WHEN** the server commits a mutation but the connection fails before the runner receives its outcome
- **THEN** the runner SHALL retry the mutation with the same idempotency key
- **AND** the server SHALL return the original outcome without applying the mutation a second time

#### Scenario: Fire-and-forget mutation completes

- **WHEN** the server commits a persistent mutation whose application handler otherwise has no response body
- **THEN** the server SHALL persist and return a serializable success acknowledgement
- **AND** the idempotency claim SHALL transition out of its in-progress state

#### Scenario: Runner restarts with pending mutations

- **WHEN** a runner restarts while its durable outbox contains unconfirmed mutations
- **THEN** it SHALL resume delivery after authentication using the original idempotency keys

#### Scenario: Idempotency conflict

- **WHEN** the same idempotency key is reused for a materially different mutation
- **THEN** the server SHALL reject it with a typed conflict outcome and SHALL NOT execute the new payload

### Requirement: Compatibility gate before production rollout

The implementation SHALL prove interoperability between the selected central-server runtime and a Rust gRPC client before removing the legacy runner transport. The gate SHALL cover prolonged bidirectional streaming, metadata and status trailers, cancellation, deadlines, slow-consumer backpressure, binary payload limits, reconnect behavior, production ingress traversal, and coexistence with the existing application listener.

#### Scenario: Compatibility suite passes

- **WHEN** every required interoperability and ingress test passes under sustained and failure-injected conditions
- **THEN** the legacy runner transport MAY be removed

#### Scenario: Direct runtime support fails the gate

- **WHEN** any required behavior cannot be made reliable in the central-server runtime
- **THEN** the legacy runner transport SHALL remain available until the implementation uses a compatible gRPC gateway boundary or stops the change without weakening the protocol requirements

## REMOVED Requirements

### Requirement: Reversible coexistence and rollout

**Reason**: The compatibility and ingress gates have passed and the migration now establishes gRPC as the sole runner-to-server transport; retaining protocol assignment and rollback paths would preserve duplicate implementations and ambiguous failure behavior.

**Migration**: Configure and expose the server gRPC listener, set the runner gRPC endpoint, upgrade runners, and verify gRPC health before deploying the server version that removes the `/runner` namespace. Browser Socket.IO remains unchanged. Durable operations accepted before the cutover remain in their existing outbox/idempotency stores and retry through gRPC.
