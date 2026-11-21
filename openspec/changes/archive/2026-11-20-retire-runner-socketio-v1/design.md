## Context

See [proposal.md](proposal.md) for motivation. The current implementation selects either native gRPC v2 or a runner-specific Socket.IO v1 namespace, can fall back to v1 after selected gRPC errors, and can bypass both through a direct runner HTTP URL. Browser clients independently use the central server's HTTP and Socket.IO interfaces and must remain compatible.

Compatibility harnesses have passed sustained bidirectional streaming, cancellation, deadlines, backpressure, payload, reconnect, ingress TLS/ALPN, and application-listener coexistence. Runtime evidence also exposed one cutover blocker: three persistent mutation handlers return `undefined`, which cannot be stored as an idempotent JSON outcome and leaves their claims in progress.

## Goals / Non-Goals

**Goals:**

- Make gRPC the single runner-to-server data plane with explicit configuration failures.
- Preserve browser-facing HTTP, Socket.IO, terminal, and session behavior.
- Complete idempotency claims for every successful persistent mutation.
- Remove dead selection, rollback, routing, configuration, and dependency surfaces.

**Non-Goals:**

- Replacing browser Socket.IO with gRPC-Web or Connect.
- Removing HTTP registration/authentication bootstrap used to obtain runner credentials.
- Changing the protobuf protocol or its version negotiation.
- Deleting historical idempotency rows or durable outbox data during deployment.

## Decisions

### Runner team mode requires an endpoint

The runtime will construct only the gRPC team transport. Missing endpoint configuration is a hard team-mode configuration error; disconnects stay within the gRPC reconnection state machine. This avoids a silent downgrade that could duplicate accepted operations. Retaining Socket.IO as an emergency fallback was rejected because it prevents removal of the legacy code and makes failures protocol-dependent.

### Server enablement remains an operational boundary, not a fallback

The server may keep an explicit listener enablement setting so installations that do not offer team runners need not bind a gRPC port. When runner service is offered, only the gRPC registry is authoritative and disabling it makes runners unavailable; it does not re-enable v1. Canary assignment and protocol rollback settings are removed.

### Browser interfaces terminate centrally

The existing browser Socket.IO namespace and HTTP APIs stay in place. Their runner dispatch paths use the gRPC session registry exclusively. The runner `/runner` namespace and direct HTTP proxy route are removed. A browser-native gRPC server was rejected because browser clients do not support native HTTP/2 gRPC semantics directly and it would unnecessarily change the public API.

### Successful persistent mutations always produce an acknowledgement

Handlers that previously returned no value will return the existing serializable data acknowledgement shape. This preserves fire-and-forget caller semantics while allowing the idempotency store to canonicalize, persist, and replay a completed result. Existing stuck claims are not mutated during deployment; their retention policy expires them safely.

### Remove dead protocol surfaces after routing is exclusive

Runner-v1 event handlers, namespace registration, fallback branches, legacy protocol exports, and the runtime's Socket.IO client dependency will be removed once references are audited. Browser-specific Socket.IO modules and the server dependency remain.

## Risks / Trade-offs

- [Misconfigured endpoint makes runners unavailable] → Fail early with an actionable message and document required server/runner variables.
- [Server-first deployment disconnects old runners] → Deploy gRPC-capable runners and verify their sessions before deploying namespace removal.
- [gRPC outage has no protocol escape hatch] → Preserve bounded reconnect, health metrics, typed failures, and roll back the application release rather than changing protocol at runtime.
- [Removing shared helpers breaks browser behavior] → Keep browser-facing contract tests and run the full protocol harness, lint, typecheck, and targeted service tests.
- [Historical in-progress claims retry before expiry] → Do not rewrite durable state; document expiry and monitor typed retry results.

## Migration Plan

1. Deploy the server with its gRPC listener reachable through production ingress and retain the existing application listener.
2. Configure every runner with the gRPC endpoint, upgrade it, and verify authenticated active sessions plus empty persistent outboxes.
3. Deploy the gRPC-only runtime/server release, which removes v1 assignment, `/runner`, and direct HTTP fallback.
4. Monitor session reconnects, typed failures, backlog, gaps, latency, and idempotency completion.
5. Roll back the release binaries if needed; do not dynamically downgrade an active runner to Socket.IO. Accepted durable mutations retain their original keys and retry after gRPC recovery.
