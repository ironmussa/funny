## Why

The runner gRPC transport has passed compatibility, sustained-load, ingress, reconnect, deadline, cancellation, backpressure, and payload verification, while production-shaped logs show the active runner operating through gRPC without pending outbox work or replay gaps. Keeping the legacy runner Socket.IO and direct-HTTP fallback now duplicates routing and failure semantics, and masks transport defects instead of failing explicitly.

## What Changes

- **BREAKING**: Require configured gRPC connectivity for runner team mode; a runner no longer connects to the server through the `/runner` Socket.IO namespace.
- **BREAKING**: Remove automatic rollback from gRPC to runner Socket.IO and remove direct runner HTTP proxy fallback.
- Keep the browser-facing Socket.IO server and browser session/event APIs; only the runner-to-server transport is retired.
- Make browser PTY, session, data, event, and tunnel operations route to runners exclusively through the gRPC registry and streams.
- Return serializable acknowledgements for persistent fire-and-forget mutations so operation-idempotency claims complete successfully.
- Remove obsolete runner-v1 protocol/configuration/dependencies and replace the mixed-rollout runbook with gRPC-only operational guidance.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runner-grpc-transport`: Replace reversible v1/v2 coexistence with a gRPC-only runner-to-server contract, including explicit behavior when gRPC is unavailable and durable acknowledgements for persistent mutations.

## Impact

- Runtime team client transport selection, registration metadata, dependencies, and tests.
- Server runner namespace, browser-to-runner routing, WebSocket/HTTP tunneling, gRPC lifecycle, rollout configuration, and tests.
- Shared runner protocol exports, environment examples, OpenWiki architecture, and the runner gRPC runbook.
- Deployments must configure the runner gRPC endpoint and expose the server gRPC listener before upgrading runners; browser Socket.IO remains supported.
