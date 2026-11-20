## Why

The browser-to-server realtime boundary relies on many dynamically named Socket.IO events and ad hoc acknowledgement shapes, which makes compatibility, delivery guarantees, and reuse by native clients harder to verify than the typed `runner.v2` gRPC boundary. Funny can gain a versioned, language-neutral contract without replacing the proven browser transport or adding deployment infrastructure by carrying Protobuf messages over the existing Socket.IO connection.

## What Changes

- Introduce a versioned `browser.v1` Protobuf contract for browser-facing operations, application events, presence, terminal traffic, and browser-session traffic without exposing privileged `runner.v2` services.
- Retain Socket.IO as the web transport and carry `browser.v1` messages as binary `Uint8Array` payloads through a small set of versioned carrier events.
- Retain the default Socket.IO parser initially; a custom Protobuf parser or native WebSocket replacement is explicitly deferred until measurements demonstrate a material bottleneck.
- Replace ad hoc event payloads and acknowledgement responses incrementally with generated Protobuf envelopes, correlation identifiers, typed outcomes, sequence/revision metadata, idempotency keys, gaps, and resynchronization semantics.
- Preserve Socket.IO reconnection, transport fallback, rooms, acknowledgement timeouts, same-origin session authentication, origin validation, and existing browser/Tauri deployment behavior.
- Keep the contract transport-neutral so native GPUIX/Bun and future Rust clients can use the same `browser.v1` messages over native gRPC after their own compatibility gates pass.
- Add bounded application queues, delivery-class policies, observability, compatibility fixtures, and failure-injection gates before migrating high-volume terminal or browser-session traffic.
- Keep uploads, downloads, screenshots, and other large resources on authorized HTTP flows rather than embedding them in realtime envelopes.

## Capabilities

### New Capabilities

- `browser-v1-transport`: Defines the authenticated, typed, versioned, recoverable client-to-server contract, its Socket.IO binary carrier for web clients, and transport-neutral compatibility requirements for native clients.

### Modified Capabilities

None.

## Impact

- Adds browser-facing Protobuf schemas and generated TypeScript artifacts alongside, but isolated from, `runner.v2`.
- Affects shared socket-event contracts, the server browser namespace and event sink, client realtime dispatch, terminal and browser-session adapters, authentication middleware, protocol tooling, tests, and observability.
- Reuses the existing Socket.IO server/client dependencies and deployment topology; it does not add ConnectRPC, Envoy, a second WebSocket endpoint, or another user-managed service.
- Preserves legacy event compatibility during migration. Socket.IO remains the supported web transport unless a separate evidence-backed change later replaces it.
