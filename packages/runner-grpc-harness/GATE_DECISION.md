# Bun gRPC compatibility gate decision

**Decision date:** 2026-08-30
**Outcome:** Pass — host `runner.v2` gRPC directly in the central Bun process.
**Gateway status:** Not selected and not scaffolded.

## Decision

The central server will own an `@grpc/grpc-js` server on a dedicated HTTP/2
listener alongside the existing Bun HTTP/WebSocket listener. The deployment
ingress terminates public TLS and forwards HTTP/2 to that gRPC listener. The
runner remains the client for all five long-lived RPCs.

The Envoy container in the compatibility harness is an ingress emulator only.
It is not part of the selected production architecture and does not create a
private application gateway boundary.

## Gate evidence

| Required behavior                         | Evidence                                                           | Result |
| ----------------------------------------- | ------------------------------------------------------------------ | ------ |
| Bun/Tonic interoperability                | TLS smoke with generated `runner.v2` bindings                      | Pass   |
| Runner metadata and response metadata     | Authenticated smoke exchange                                       | Pass   |
| Existing application-listener coexistence | Bun HTTP health request while gRPC is active                       | Pass   |
| Five independent communication classes    | Concurrent control, operations, events, tunnel, and terminal calls | Pass   |
| Status and trailers                       | Tonic observes the typed final status and custom trailer           | Pass   |
| Deadlines and callee cancellation         | `DEADLINE_EXCEEDED` plus Bun cancellation observation              | Pass   |
| Explicit cancellation                     | Dropped Tonic terminal stream observed by Bun                      | Pass   |
| Keepalive                                 | Idle interval followed by successful control traffic               | Pass   |
| Slow-reader backpressure                  | Tunnel writes report backpressure while other classes progress     | Pass   |
| Bounded binary payloads                   | A 65,537-byte frame is rejected as `RESOURCE_EXHAUSTED`            | Pass   |
| Forced disconnect and reconnect           | `UNAVAILABLE` followed by a successful new control stream          | Pass   |
| Production-like ingress                   | Three full passes through TLS/ALPN-h2 Envoy ingress                | Pass   |
| Recorded resource thresholds              | 3.483 s max, 98 MiB Bun RSS, 57.14 MiB Envoy memory                | Pass   |

Commands:

```sh
bun run protocol:compat:harness
bun run --cwd packages/runner-grpc-harness test:sustained
bun run protocol:compat:ingress
```

See [`INGRESS.md`](INGRESS.md) for the ingress topology, pinned image,
thresholds, host details, and recorded measurements.

## Implementation consequences

- Task 3.1 must add the production gRPC listener to `packages/server` behind a
  disabled feature flag; it must not introduce a gateway service.
- The gRPC listener remains distinct from the current browser HTTP/WebSocket
  listener. Browser behavior and protocols remain unchanged.
- TLS termination may occur at the deployment ingress. The private hop to Bun
  must preserve HTTP/2, and route/stream-idle timeouts must not be shorter than
  the application lifecycle.
- Authentication, authorization, limits, session epochs, recovery, and
  observability remain application responsibilities; passing the transport
  gate does not implement those later tasks.
- Production traffic remains disabled until the feature flag, lifecycle tests,
  canary controls, and rollback path are implemented.

## Gateway fallback triggers

The gateway alternative is retained as a contingency, not implemented now.
Reopen this decision before canary if the actual deployment ingress cannot
preserve native gRPC streaming, or if production-like load reveals unreliable
trailers, cancellation, flow control, reconnects, or bounded memory that cannot
be fixed in the direct Bun endpoint without weakening the public Protobuf
contract. If reopened, the external `runner.v2` contract stays unchanged.
