# Bun to Tonic compatibility harness

This package is an executable decision-gate harness for the `runner.v2` native
gRPC transport. It is not a production endpoint.

The smoke run starts a Bun HTTP listener alongside a TLS `@grpc/grpc-js`
server, then runs the generated Rust Tonic client against the runner-initiated
`Control` stream. The server requires runner authorization metadata and the
client verifies response metadata plus the negotiated protocol version.

```sh
bun run protocol:compat:harness
```

The sustained suite keeps all five bidirectional calls active while a tunnel
reader is deliberately stalled. It verifies status trailers, deadline and
explicit cancellation propagation, HTTP/2 keepalive across an idle interval,
per-stream binary limits, an injected disconnect followed by a new control
stream, and concurrent control/operations/events/tunnel/terminal progress.

```sh
bun run --cwd packages/runner-grpc-harness test:sustained
```

The chaos soak repeats that profile for 20 minutes by default (allowed range:
15–30). It fails on leaked calls/backlog, excess RSS or RSS growth, missing
disconnect/reconnect coverage, stalled streams, or slow-consumer regressions.
It runs on the scheduled/manual `runner-grpc.yml` workflow; use it locally when
changing framing, flow control, reconnect, replay, or cancellation behavior.

```sh
bun run --cwd packages/runner-grpc-harness test:soak
# Optional: RUNNER_GRPC_SOAK_MINUTES=15 bun run --cwd packages/runner-grpc-harness test:soak
```

The ingress gate repeats that suite three times through a pinned Envoy edge
container. Envoy terminates TLS 1.2+ with ALPN `h2`, forwards HTTP/2 cleartext
to the Bun service, and disables route and stream-idle timeouts so application
deadlines remain authoritative. Docker is required for this command.

```sh
bun run --cwd packages/runner-grpc-harness test:ingress
```

See [`INGRESS.md`](INGRESS.md) for the Railway-derived constraints, acceptance
thresholds, Envoy topology, and the latest recorded measurement.
The resulting direct-Bun selection is recorded in
[`GATE_DECISION.md`](GATE_DECISION.md).

The gate fails if any run takes more than 30 seconds, Bun exceeds 256 MiB peak
RSS, or Envoy exceeds 128 MiB. Its JSON output records measured duration, Bun
CPU/RSS, and Envoy CPU/memory for the exact Linux environment that ran it.

The certificate and private key under `fixtures/` are self-signed test assets
for `localhost`; they are not deployment credentials.
