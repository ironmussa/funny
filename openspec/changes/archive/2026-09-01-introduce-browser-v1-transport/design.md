## Context

Funny's web and packaged WebView clients already communicate with the Bun server through one authenticated Socket.IO connection. Application behavior is spread across dynamically named events, payload interfaces, acknowledgements, rooms, and reconnect hooks. `BrowserEventSink` provides a partial server-side boundary, but the wire contract itself is not versioned or language-neutral.

The server also exposes the private `runner.v2` gRPC boundary. That boundary is not suitable for user clients because its identity, authorization, and lifecycle are runner-specific. See `proposal.md` for the motivation and `specs/browser-v1-transport/spec.md` for required behavior.

The deployment constraint is decisive: local Funny must remain a single-command installation, regular browsers must continue using same-origin sessions, and packaged clients must preserve their configured server resolution. The design therefore cannot require Envoy, ConnectRPC, another public port, or a second realtime connection.

## Goals / Non-Goals

**Goals:**

- Define one versioned `browser.v1` application contract reusable by TypeScript and Rust clients.
- Carry that contract over the existing Socket.IO connection for web and WebView clients.
- Introduce typed operation outcomes, delivery classes, correlation, sequencing, recovery, and bounded buffering incrementally.
- Preserve legacy events as an independently selectable rollback path until every migrated traffic class passes parity and operational gates.
- Keep schemas independent of Socket.IO internals so a later native client can map the same service semantics to gRPC.

**Non-Goals:**

- Replacing Socket.IO, its Engine.IO transport, or its default parser.
- Adding ConnectRPC, gRPC-Web, a native WebSocket endpoint, Envoy, or another user-managed service.
- Exposing `runner.v2` to clients or sharing runner credentials with them.
- Implementing a native GPUIX/Bun or Rust gRPC adapter in this change.
- Moving large uploads, downloads, screenshots, or other cacheable resources onto the realtime channel.
- Retiring legacy Socket.IO events in this change.

## Decisions

### 1. Socket.IO remains the web transport; Protobuf becomes the application wire contract

The existing authenticated Socket.IO connection will carry binary `Uint8Array` payloads encoded from `browser.v1` Protobuf messages. Socket.IO continues to own connection establishment, WebSocket/polling selection, reconnection, rooms, and acknowledgement timeouts. Funny owns message validation, authorization, delivery semantics, recovery, and resource bounds.

The initial carrier uses a small stable set of event names rather than one name per domain event:

```text
browser:v1:negotiate     capability/version negotiation
browser:v1:operation     request with a binary acknowledgement outcome
browser:v1:event         server-to-client application event
browser:v1:interactive   bidirectional ephemeral or streaming traffic
browser:v1:control       gap, snapshot, cancellation, and protocol control
```

Exact constants may be consolidated where tests show that fewer carrier names preserve acknowledgement and priority behavior. Domain meaning always lives inside the Protobuf envelope, never in a dynamically constructed Socket.IO event name.

Alternative considered: replace Socket.IO with native WebSocket. That would reduce framing overhead and expose Bun backpressure more directly, but would require rebuilding reconnect, fallback, rooms, acknowledgements, and lifecycle behavior before gaining contract safety. It remains a separate, measurement-driven future change.

Alternative considered: ConnectRPC plus WebSocket. It provides RPC-shaped HTTP APIs but creates two browser transports and still needs a separate bidirectional channel. It is unnecessary once Socket.IO payloads are typed.

### 2. Use the default Socket.IO parser initially

Protobuf bytes are passed as Socket.IO binary attachments. The carrier does not encode Socket.IO packet type, namespace, acknowledgement ID, or attachment metadata. This isolates `browser.v1` from Socket.IO implementation details and retains polling fallback.

A custom Protobuf Socket.IO parser is deferred. It may reduce frames or metadata, but it couples both endpoints to Socket.IO's parser contract and complicates upgrades. It requires benchmark evidence and a separate compatibility review.

### 3. Separate service semantics from transport envelopes

The schema tree is divided into common metadata, operations, events, interactive messages, and transport envelopes. Generated application messages must not import Socket.IO types.

```text
browser.v1 application messages
            │
      ┌─────┴──────────────┐
      │                    │
Socket.IO carrier      future native gRPC adapter
web / WebView          GPUIX/Bun or Rust
```

Native gRPC compatibility means equivalent request, outcome, event, status, authorization, and delivery semantics—not wire compatibility between Socket.IO and gRPC. A native adapter is enabled only after its runtime and ingress pass dedicated unary, streaming, cancellation, authentication, and soak gates.

### 4. Negotiate once per connection and assign rollout by traffic class

After Socket.IO authentication, the client sends supported protocol versions, generated-schema fingerprint, capabilities, and client/deployment identity. The server selects a compatible version and independently assigns `operations`, `events`, `terminal`, and `browser_session` to either legacy or `browser.v1` representation.

For any logical message, a client receives exactly one representation. Shadow mode may encode and measure a new representation, but it must not dispatch it to application state. Assignment is server-controlled and observable, enabling rollback without reconnecting to another endpoint.

### 5. Operations use Socket.IO acknowledgements with typed binary outcomes

Unary-style operations use the `browser:v1:operation` carrier and Socket.IO acknowledgement callback. The request envelope contains `request_id`, deadline, operation `oneof`, optional idempotency key, and causal metadata. The acknowledgement contains a typed success or status outcome correlated to the request.

Socket.IO acknowledgement IDs are transport details and are not used as application request IDs. Cancellation uses an explicit control envelope because an acknowledgement timeout alone does not cancel downstream work. Durable retryable mutations persist an idempotency record long enough to return the original compatible result after a lost acknowledgement.

### 6. Events use scoped ordering and recovery appropriate to their delivery class

Durable application events receive a stable `event_id`, scope, sequence or revision, occurrence time, and optional causal request ID. On reconnect, the client provides its last accepted cursor per subscribed scope. The server either replays retained events or explicitly requests a targeted authoritative snapshot.

Not every payload is replayed:

| Delivery class       | Examples                                      | Recovery                            |
| -------------------- | --------------------------------------------- | ----------------------------------- |
| Durable              | messages, jobs, committed mutations           | cursor replay, then snapshot on gap |
| Snapshot-recoverable | git/runner state, presence                    | fetch current authoritative state   |
| Coalescible          | resize, latest browser frame                  | keep latest required value          |
| Volatile             | heartbeat, transient progress                 | drop when stale                     |
| At-most-once         | terminal input, destructive interactive input | never replay implicitly             |

The first rollout may use snapshot recovery for domains that do not yet have a retained event log. The contract still reports gaps explicitly; it never pretends that Socket.IO connection recovery is durable application replay.

### 7. Bound queues at the application layer

Socket.IO's send buffers do not replace application flow control. The carrier enforces per-connection and per-delivery-class byte/message/concurrency limits before encoding or enqueueing. Coalescible and volatile traffic can be replaced or dropped according to schema policy; durable traffic must be rejected, persisted, or force a resynchronization rather than silently discarded.

Control, cancellation, terminal exit, and terminal error messages receive reserved capacity or a separate carrier priority so bulk terminal output and browser frames cannot starve completion signals. High-volume terminal and browser-session migration remains disabled until slow-consumer and memory tests pass.

### 8. Authentication comes from the connection; authorization occurs per message

The Socket.IO handshake continues deriving the principal from the server-recognized session and allowed origin. Envelope fields may reference resources but cannot select or override the principal. Every operation, subscription, terminal, and browser-session message is authorized when dispatched, and protected subscriptions are terminated within a configured bound after session/share revocation.

Malformed, oversized, unknown, or unauthorized envelopes produce safe typed status outcomes without partial dispatch or protected-resource disclosure. Logs and metrics record metadata and sizes, not credentials or payload content.

### 9. Large resources remain HTTP references

Uploads, downloads, screenshots, and large browser frames continue through authorized HTTP endpoints with existing range, cache, and size controls. Realtime messages carry typed references and lifecycle notifications. Small policy-compliant interactive chunks may remain on Socket.IO where latency requires it.

## Risks / Trade-offs

- **Socket.IO plus Protobuf still has Socket.IO framing overhead** → Measure payload count, bytes, CPU, memory, and latency before considering a custom parser or native WebSocket.
- **Binary attachments may use multiple Engine.IO frames** → Include polling and WebSocket modes in the compatibility harness and set conservative message limits.
- **Protobuf does not itself provide delivery guarantees** → Encode delivery class, IDs, sequences, idempotency, gaps, and snapshot behavior in the application protocol and test failure paths.
- **Dual representations can double-apply state** → Assign each traffic class and logical message to exactly one dispatched representation; restrict shadow mode to telemetry.
- **A retained event log can grow without bound** → Set per-scope age/byte limits, expose gaps, and fall back to authoritative snapshots.
- **Slow terminal or frame consumers can grow Socket.IO buffers** → Apply application queue limits, coalescing/volatile policies, reserved control capacity, and disconnect/resource-exhausted outcomes.
- **Generated schemas may increase browser bundle size** → Generate isolated modules, import payload schemas by domain, and enforce bundle thresholds.
- **Native gRPC semantics may drift from the web carrier** → Maintain shared golden fixtures and semantic conformance tests before enabling any native adapter.
- **Long migrations increase maintenance cost** → Migrate coherent domains, publish parity metrics, and remove compatibility only through a later reviewed retirement change.

## Migration Plan

1. Add `browser.v1` schemas, generated TypeScript code, Buf compatibility gates, and cross-language golden fixtures without changing runtime traffic.
2. Add carrier codec/validation modules and negotiation on the existing Socket.IO namespace. Keep every traffic class assigned to legacy representation.
3. Introduce transport-neutral client dispatch and server publication ports while preserving current legacy behavior through parity tests.
4. Canary a low-risk read operation such as `pty:list` through the typed operation carrier and verify acknowledgement, timeout, auth, reconnect, and rollback behavior.
5. Canary a low-volume event domain with explicit snapshot recovery; validate no duplicate dispatch and observable gaps.
6. Expand operations and events domain by domain after state-parity and failure-injection gates pass.
7. Migrate terminal and browser-session traffic independently only after queue-pressure, latency, polling fallback, disconnect, and memory gates pass.
8. Make `browser.v1` the default representation per validated cohort while retaining immediate per-class rollback to legacy events.
9. Evaluate custom parsers, native WebSocket, and native gRPC adapters only from collected measurements and separate proposals.
10. Retire legacy Socket.IO event representations only through a later change with a released-client compatibility window.

Rollback changes only server-side traffic-class assignment. Durable mutations retain idempotency records and authoritative state; rollback must not replay at-most-once interactive input.

## Open Questions

- The initial retained-event age and byte budgets will be chosen from measured event volume during the canary; snapshot fallback is required regardless of the chosen values.
- Initial terminal output recovery may remain live-only if bounded replay cannot meet memory limits; the protocol reports a gap either way.
