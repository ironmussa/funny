# Runner gRPC operations runbook

Runner-to-server communication uses native `runner.v2` gRPC exclusively. The
browser continues to use the central server's HTTP and Socket.IO interfaces;
browsers do not connect to this listener.

## Required deployment configuration

The server binds `RUNNER_GRPC_HOST:RUNNER_GRPC_PORT` when
`RUNNER_GRPC_ENABLED` is not `false`. Expose that listener through an ingress
that terminates TLS 1.2 or newer, negotiates ALPN `h2`, and preserves HTTP/2 on
the private hop. Configure every runner's `RUNNER_GRPC_ENDPOINT` with the
externally reachable host and port.

The route must preserve bidirectional streaming, status/trailers, cancellation,
and backpressure. Its idle timeout must exceed `RUNNER_GRPC_HEARTBEAT_TIMEOUT_MS`.
Verify the production-shaped route with:

```sh
bun run protocol:compat:ingress
```

## Deployment order

1. Deploy and verify the server gRPC listener and ingress.
2. Configure `RUNNER_GRPC_ENDPOINT` on every runner and verify authenticated
   sessions plus all five stream classes.
3. Deploy the gRPC-only server/runtime release. There is no `/runner` namespace,
   direct runner HTTP fallback, canary assignment, or runtime protocol downgrade.
4. Monitor reconnects, typed failures, queue depth, receipt lag, gaps, latency,
   and idempotency completion.

Deploying the gRPC-only server before upgrading runners makes old runners
unavailable. A missing endpoint causes team-mode startup to fail explicitly.

## Dashboard and alerts

Build panels from `runner.grpc.transport.events`, grouped by
`protocolVersion`, `streamClass`, `event`, and `status`. Include:

- active/opened and closed streams by communication class;
- session replacements and heartbeat expiry;
- completed versus failed operations and typed status;
- `runner.grpc.queue.depth` and `runner.grpc.receipt.lag` maxima;
- `runner.grpc.gap.size` count/distribution;
- `runner.grpc.latency` p50, p95, and p99.

Transport logs use namespace `runner-grpc` and contain only safe identifiers,
epochs, statuses, counters, and timings. Do not add credentials or payload bodies.

## Durable state and cleanup

- Server mutation outcomes default to seven days
  (`RUNNER_GRPC_IDEMPOTENCY_RETENTION_MS`) and expire lazily.
- Runner mutation outbox entries remain until an application outcome confirms
  the original idempotency key.
- Runner event replay is bounded per execution; an expired cursor produces an
  explicit gap and durable resynchronization.
- Terminal output replay is bounded. Terminal input is never retained or replayed.

Do not manually remove unexpired `runner_operation_idempotency` rows or delete
`runner-grpc-outbox.db` while entries remain. Historical `in_progress` claims
whose old handler outcome was not serializable must expire under the normal
retention policy.

## Incident rollback

There is no in-process downgrade to Socket.IO. If gRPC health regresses:

1. Stop new work and inspect ingress HTTP/2/trailer behavior plus gRPC metrics.
2. Roll back the server and runtime release binaries as one coordinated change.
3. Preserve idempotency tables, runner outboxes, and event replay stores.
4. After recovery, verify original idempotency keys replay without duplicate
   execution and terminal input was not replayed.

If ingress cannot preserve required semantics, use a compatible gRPC gateway
boundary or stop the deployment; do not reintroduce a second runner protocol.
