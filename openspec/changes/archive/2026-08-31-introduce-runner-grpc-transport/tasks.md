## 1. Protocol Contract and Tooling

- [x] 1.1 Add the versioned `runner.v2` Protobuf package for common identifiers/status, control, operations, events, tunnels, and terminals, with every long-lived RPC initiated by the runner.
- [x] 1.2 Add reproducible Protobuf linting, compatibility checks, and TypeScript/Rust binding generation to the workspace without retaining hand-written duplicate wire types.
- [x] 1.3 Add golden compatibility fixtures for version negotiation, typed failures, binary frames, idempotency metadata, event receipts/gaps, and terminal sequences, and verify them against both generated language bindings.
- [x] 1.4 Document field evolution, reserved-field, package-versioning, generated-artifact, and compatibility policies for future protocol changes.

## 2. Bun and Tonic Compatibility Gate

- [x] 2.1 Build an executable harness with the candidate Bun gRPC server stack and a Rust `tonic` client, including TLS runner metadata and coexistence with the current application listener.
- [x] 2.2 Add sustained bidirectional-streaming tests for status/trailers, deadlines, cancellation, keepalive, slow readers, bounded binary payloads, forced disconnects, and concurrent communication classes.
- [x] 2.3 Exercise the harness through the production-like ingress and record reproducible pass thresholds, required HTTP/2/TLS/timeout settings, and measured resource use.
- [x] 2.4 Record the gate decision: host gRPC directly in Bun if every required behavior passes, otherwise scaffold the compatible gRPC gateway and its private typed Bun boundary without changing the public Protobuf contract.

## 3. Server Transport Foundation

- [x] 3.1 Implement the selected server endpoint behind a disabled feature flag with TLS metadata authentication, typed interceptors, safe correlation logging, and per-runner limits.
- [x] 3.2 Implement control-stream negotiation for protocol/capabilities, effective limits, heartbeat timing, resume cursors, and typed incompatibility responses before work dispatch begins.
- [x] 3.3 Add an atomic active-session registry with monotonically changing epochs so replacement sessions invalidate stale streams without stale cleanup marking the runner offline.
- [x] 3.4 Derive runner/user/tenant identity from credentials and enforce resource authorization and operation allowlists without trusting payload identity.
- [x] 3.5 Add focused security and lifecycle tests for invalid/revoked credentials, cross-tenant references, unsupported versions, heartbeat expiry, and zombie-session replacement.

## 4. Operations and Durable Delivery

- [x] 4.1 Implement typed read and mutation dispatch on the operations stream with correlation IDs, deadlines, concurrency limits, cancellation, and typed outcomes.
- [x] 4.2 Add a durable runner outbox for retryable persistent mutations, preserving original idempotency keys across reconnects and process restarts.
- [x] 4.3 Add server-side idempotency records with request fingerprints, stored outcomes, conflict detection, transactional execution where supported, retention, and cleanup.
- [x] 4.4 Add failure-injection tests proving a disconnect after commit cannot duplicate state, a restarted runner retries pending work, conflicting key reuse is rejected, and abandoned work is cancelled.

## 5. Resumable Agent Events

- [x] 5.1 Implement per-thread-execution event sequences, cumulative durable receipts, bounded replay storage, and resume from the last accepted contiguous sequence.
- [x] 5.2 Implement explicit gap responses and durable thread resynchronization when requested history is unavailable.
- [x] 5.3 Reserve queue capacity and scheduling priority for agent result/error events so chunk pressure cannot silently discard terminal state.
- [x] 5.4 Add reconnect, duplicate receipt, out-of-order, expired-history, slow-consumer, and chunk-storm tests that verify terminal events remain deliverable.

## 6. HTTP Tunnel and Terminal Streams

- [x] 6.1 Implement framed binary HTTP tunnel requests and responses with stream ordering, configured chunk/message limits, end/error states, deadlines, and end-to-end cancellation.
- [x] 6.2 Implement terminal sessions with at-most-once input, sequenced bounded-replay output, coalesced resize updates, cancellation, and per-terminal resource limits.
- [x] 6.3 Connect existing browser HTTP/WebSocket adapters to gRPC runners without changing their public behavior or requiring gRPC-Web.
- [x] 6.4 Add tests for large uploads/downloads, client abandonment, slow tunnel consumers, terminal reconnect within and beyond retention, non-replayed input, and isolation from control/event progress.

## 7. Existing TypeScript Runner Integration

- [x] 7.1 Add the generated gRPC client and channel lifecycle to the existing TypeScript runner, including credential metadata, capability advertisement, reconnect, keepalive, and graceful shutdown.
- [x] 7.2 Route the current runner control, data, agent-event, tunnel, and PTY implementations through the v2 client while preserving their application semantics.
- [x] 7.3 Ensure each runner session activates exactly one transport and cannot duplicate commands or events across Socket.IO v1 and gRPC v2.
- [x] 7.4 Run the complete protocol contract against the TypeScript runner before any future Rust runtime capability port begins.

## 8. Observability, Canary, and Rollback

- [x] 8.1 Add protocol-version/session-epoch metrics and structured logs for connection health, reconnects, typed errors, deadlines, queue depth, receipt lag, gaps, and latency without credentials or payload bodies.
- [x] 8.2 Add server-side canary assignment and health thresholds while retaining exclusive routing for a mixed Socket.IO v1 and gRPC v2 fleet.
- [x] 8.3 Implement and rehearse rollback that stops new v2 assignments, drains or cancels transient work, preserves accepted durable operations, and returns eligible runners to v1.
- [x] 8.4 Document deployment ingress requirements, operational dashboards/alerts, deduplication and replay retention, cleanup procedures, canary expansion, and rollback steps.

## 9. Verification

- [x] 9.1 Run the shared Protobuf fixtures and focused server, runtime, security, recovery, tunnel, terminal, and mixed-fleet test suites.
- [x] 9.2 Run the sustained Bun-or-gateway to Tonic compatibility and ingress harness using the recorded acceptance thresholds.
- [x] 9.3 Run `bun run lint` and resolve errors or warnings introduced by this change.
- [x] 9.4 Run `bun run typecheck` and resolve workspace type errors introduced by this change.
- [x] 9.5 Run strict OpenSpec validation and confirm every requirement scenario is covered by implementation or an automated test before completing the change.
