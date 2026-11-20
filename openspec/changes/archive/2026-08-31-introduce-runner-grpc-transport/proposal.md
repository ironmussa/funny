## Why

The current runner connection couples the runtime to Socket.IO-specific callbacks, acknowledgements, and relays, while still allowing silent event loss and ambiguous mutation outcomes across disconnects. A native gRPC and Protobuf boundary gives the current TypeScript runner and a future Rust runner one typed, streaming-capable contract with explicit delivery and recovery semantics.

## What Changes

- Introduce a versioned Protobuf contract and native gRPC transport for all runner-to-central-server communication: control, data operations, agent events, HTTP tunneling, and PTY traffic.
- Require the runner to initiate long-lived bidirectional streams so runners remain deployable behind NAT and outbound-only firewalls.
- Define application-level idempotency, durable outbox, sequencing, acknowledgement, resume, and explicit gap behavior for failures that transport-level flow control cannot resolve.
- Define authentication, tenant-derived identity, operation allowlists, resource authorization, deadlines, cancellation, message-size limits, and bounded buffering at the gRPC boundary.
- Add a Bun server to Rust `tonic` compatibility spike as a decision gate before production implementation, covering prolonged streaming, trailers, cancellation, backpressure, large binary messages, ingress behavior, and coexistence with the existing listener.
- Run Socket.IO v1 and gRPC v2 side by side during migration, with each runner selecting exactly one protocol per connection.
- Preserve HTTP and WebSocket communication between browsers and the central server; browser transport is outside this change.
- Defer the Rust runtime rewrite and capability ports (ACP, Git, filesystem, processes, and PTY implementation) to subsequent changes.

## Capabilities

### New Capabilities

- `runner-grpc-transport`: Defines the versioned runner gRPC contract, stream isolation, delivery and recovery guarantees, security boundary, compatibility gate, and coexistence with the legacy Socket.IO transport.

### Modified Capabilities

None.

## Impact

- Affected areas include `packages/server`, `packages/runtime`, `packages/shared`, deployment ingress configuration, and new protocol definitions and generated TypeScript/Rust bindings.
- New dependencies are expected for Protobuf generation, the TypeScript/Bun gRPC server or a validated gateway alternative, and Rust `tonic` test clients.
- Runner authentication and authorization move to typed gRPC metadata and server-derived identity; existing browser APIs remain unchanged.
- Rollout requires protocol negotiation, observability by protocol version, failure-injection tests, and a reversible canary before Socket.IO runner support can be retired in a later change.
