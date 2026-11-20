## Context

See [proposal.md](proposal.md) for motivation. Today the central server and TypeScript runner use a Socket.IO namespace with event-specific callbacks, a separate request-id response mechanism for persistence, and relay handlers for agent, tunnel, browser-session, and PTY traffic. Socket transport flow control does not define durable recovery: an acknowledgement can be lost after a mutation commits, and rate-limited chunks can be discarded without a resumable sequence.

The central application runs on Bun, while the intended future runner is Rust. Browser clients still require the existing HTTP and WebSocket surface. Runners must initiate outbound connections, and the deployment ingress must support long-lived HTTP/2 streams. Bun's compatibility with the chosen Node gRPC server stack is not assumed; it must be demonstrated before the production path is selected.

## Goals / Non-Goals

**Goals:**

- Make Protobuf the language-neutral source of truth for runner/server messages and compatibility.
- Carry every runner/server interaction over native gRPC with independent flow control for unrelated traffic classes.
- Define recovery above the transport for ambiguous mutations, reconnects, and lost stream history.
- Keep authenticated identity, authorization, resource limits, cancellation, and observability at the transport boundary.
- Preserve a reversible mixed-fleet migration from Socket.IO.

**Non-Goals:**

- Port agent providers, filesystem, Git, process, worktree, or PTY implementations to Rust.
- Replace browser HTTP or WebSocket communication with gRPC-Web.
- Promise distributed exactly-once delivery or indefinite replay history.
- Remove Socket.IO runner support in this change.
- Redesign existing application authorization rules or persistence models beyond transport recovery metadata.

## Decisions

### Protobuf is the normative contract

Protocol definitions live in a top-level runner protocol package, organized by version. A representative layout is:

```text
protocol/runner/v2/
├── common.proto
├── control.proto
├── operations.proto
├── events.proto
├── tunnel.proto
└── terminal.proto
```

Generated TypeScript and Rust bindings are build artifacts checked or generated consistently by repository tooling; hand-written wire types do not duplicate the contract. CI performs breaking-change detection and runs the same golden fixtures against both languages. Fields are only added compatibly within v2; incompatible semantics require a new package version.

JSON Schema plus a custom WebSocket envelope was considered. Protobuf is preferred because gRPC already supplies framing, typed status, cancellation, deadlines, binary payloads, and streaming code generation in both target languages.

### One runner channel exposes five isolated communication classes

The runner creates one logical gRPC channel to the central endpoint and opens long-lived calls for the traffic it supports:

```proto
service RunnerTransport {
  rpc Control(stream RunnerControl) returns (stream ServerControl);
  rpc Operations(stream OperationRequest) returns (stream OperationResponse);
  rpc Events(stream RunnerEvent) returns (stream EventReceipt);
  rpc Tunnel(stream TunnelFrame) returns (stream TunnelFrame);
  rpc Terminal(stream TerminalFrame) returns (stream TerminalFrame);
}
```

`Control` negotiates protocol/capabilities and carries heartbeat, commands, cancellation, and presence. `Operations` multiplexes typed reads and mutations by operation ID. `Events` carries scoped agent sequences and receipts. `Tunnel` and `Terminal` carry independently framed binary streams.

Separate calls prevent a slow tunnel or terminal from causing application-level head-of-line blocking for control and terminal agent events. They still reuse the gRPC channel and HTTP/2 multiplexing where the client and ingress permit it. The design does not depend on there being exactly one physical TCP connection.

A single bidirectional `Connect` stream was considered but rejected because one buffer and one application scheduler would couple all traffic classes. Separate unary RPCs for every operation were also considered; the long-lived operations stream is preferred for outbound-only runners and explicit replay of outbox entries after channel replacement.

### The runner is always the gRPC client

Every streaming RPC is initiated by the runner. Server-to-runner commands are responses on the runner-initiated `Control` stream, and browser-triggered tunnel or terminal traffic is relayed over runner-initiated streams. This preserves the existing outbound connectivity model and avoids exposing a runner listener.

### Session negotiation precedes work

The first control exchange contains protocol version, runner instance ID, supported features, payload limits, and resume cursors. The server replies with the selected version, session epoch, effective limits, heartbeat interval, and accepted resume positions. Work is dispatched only after this handshake completes.

Each accepted session receives a monotonically changing epoch. Handlers compare the active epoch before mutating presence, so cleanup from a superseded stream cannot mark its replacement offline. The server closes an older session after atomically activating the newer one.

### Transport acknowledgement and durable acknowledgement are distinct

HTTP/2/gRPC flow control protects only a live connection. Application receipts therefore identify the highest contiguous sequence durably accepted for each event scope. The runner does not remove a durable mutation or required event from its outbox until it receives the corresponding application receipt.

Persistent mutations use an idempotency key scoped by authenticated runner identity and operation kind. The server stores a request fingerprint, status, and serialized outcome long enough to cover the retry policy. An identical retry returns the stored outcome; a different request with the same key fails as a conflict. Database execution and deduplication recording share a transaction when supported, or use an operation-specific atomic equivalent.

Exactly-once delivery was rejected because neither gRPC nor a reconnect can determine an ambiguous commit by itself. At-least-once delivery plus idempotent application is sufficient and testable.

### Events use scoped sequences and explicit gaps

Agent events are sequenced per thread execution (not globally), which keeps counters independent and replay buffers bounded. Receipts acknowledge the highest contiguous durably applied sequence. On resume, the server supplies that cursor and the runner begins at the next sequence.

If the cursor predates retained history, the runner emits a typed gap with the earliest available sequence. The server reloads durable thread state and informs browser subscribers through existing resynchronization behavior. Terminal agent results/errors use reserved durable capacity and a higher scheduling priority than disposable chunks.

PTY input is intentionally different: it is not replayed after an ambiguous disconnect because repeated keystrokes can execute unintended commands. PTY output is sequenced with a bounded in-memory replay window, and resize messages are coalesced by terminal ID.

### Authentication is channel-bound and payload identity is non-authoritative

Runner credentials are sent in gRPC metadata over TLS. Authentication resolves runner ID, user/tenant identity, credential state, and allowed capabilities once per channel/session. Interceptors apply authentication, limits, request correlation, and safe logging; operation handlers still authorize every resource reference using the resolved principal.

Message schemas omit caller-controlled tenant identity wherever possible. If compatibility requires such a field, it is treated only as an assertion and must equal the authenticated identity. Secrets and payload bodies are excluded from logs and metrics.

Mutual TLS was considered but deferred: bearer runner credentials over TLS preserve the current provisioning model. The contract leaves room to add certificate identity later without changing operation payloads.

### Resource limits and cancellation are end-to-end

Negotiated limits cover frame size, active tunnels, active terminals, pending operations, and per-class buffered bytes. Each request has a correlation ID and effective deadline. Cancellation from browsers or server shutdown crosses the corresponding gRPC call/frame and aborts runner-side work where possible. Per-class bounded queues use fair scheduling, with reserved control and terminal-event capacity.

Large tunnel bodies are chunked into `bytes` frames rather than base64. Frames carry operation ID, ordering, end/error status, and optional metadata only at stream start. Chunk size remains below the configured gRPC message maximum.

### Bun compatibility is a decision gate, not an assumption

The first implementation artifact is an executable compatibility harness: a minimal central gRPC endpoint using the candidate Bun stack and a Rust `tonic` client. It runs sustained bidirectional traffic, trailers/status tests, deadline and cancellation propagation, slow readers, bounded large binaries, forced disconnect/resume, ingress traversal, TLS/metadata, and coexistence with the current HTTP listener.

Passing thresholds and test duration are recorded in the harness so the result is reproducible. If direct Bun hosting passes, the central server owns the gRPC endpoint. If it fails any required behavior, a small compatible gRPC gateway (preferably Rust) terminates gRPC, enforces framing/session semantics, and communicates with Bun over a private typed boundary. The external Protobuf contract and runner remain unchanged. Weakening streaming or recovery semantics to fit Bun is not an accepted fallback.

### Gate outcome: direct Bun hosting selected

The compatibility gate passed on 2026-08-30, including the sustained
failure-injected suite and three runs through the production-like ingress.
The central Bun process SHALL therefore own the gRPC server on a dedicated
listener alongside the existing browser HTTP/WebSocket listener. No compatible
gateway is scaffolded at this stage. The evidence, resource measurements,
operational constraints, and conditions that would reopen the fallback are
recorded in
[`packages/runner-grpc-harness/GATE_DECISION.md`](../../../../packages/runner-grpc-harness/GATE_DECISION.md).

### Browser transports remain adapters

Browser HTTP and WebSocket handlers keep their public behavior. The central server maps their requests to an active runner transport selected by runner identity. Responses and events return through existing browser channels. No gRPC-Web dependency is introduced because browser bidirectional streaming support does not cover the required interaction model consistently.

### Rollout is per runner session

A gRPC-capable runner advertises and selects v2 at connection time; legacy runners continue using Socket.IO v1. The central registry stores one active protocol and session epoch per runner, making dispatch exclusive. Metrics and structured logs include protocol version, session epoch, stream class, typed status, reconnect reason, queue depth, receipt lag, gaps, and latency, but not payload content.

Canary assignment is controlled server-side. Rollback stops new v2 assignments, drains or cancels transient calls, preserves outbox/deduplication records, and allows eligible runners to reconnect on v1. Removing v1 requires a later change after fleet adoption and rollback-window completion.

## Risks / Trade-offs

- **[Bun gRPC behavior differs from Node under sustained streams]** → Make the compatibility harness the first gate and retain a contract-preserving gateway fallback.
- **[Production ingress does not preserve HTTP/2 streaming semantics]** → Test the real ingress path before canary and document required timeout, keepalive, TLS, and protocol settings.
- **[Generated bindings drift or introduce breaking fields]** → Generate both languages from one versioned source and enforce linting, breaking-change checks, and shared golden fixtures in CI.
- **[Outbox and deduplication increase storage and operational complexity]** → Limit them to retryable durable operations/events, define retention and cleanup, expose backlog metrics, and test crash recovery.
- **[Multiple long-lived calls consume server resources]** → Apply per-runner concurrency/buffer limits and measure connection cost in the compatibility harness.
- **[Mixed v1/v2 routing duplicates work]** → Make active protocol selection atomic and keyed by session epoch; reject dispatch from superseded sessions.
- **[A gap can make live UI state stale]** → Signal gaps explicitly and use durable thread resynchronization instead of pretending the stream is complete.
- **[At-most-once PTY input can be lost]** → Prefer loss over unsafe replay and surface disconnection promptly so the user can inspect terminal state.

## Migration Plan

1. Add the Protobuf package, generation/lint tooling, shared fixtures, and compatibility harness without enabling a production endpoint.
2. Run the Bun↔Tonic harness locally and through the production-like ingress; record the direct-host or gateway decision.
3. Implement authentication, session negotiation, resource limits, and the control stream behind a disabled feature flag.
4. Implement operations plus durable outbox/deduplication, then sequenced agent events and gap recovery.
5. Add tunnel and terminal streams with cancellation, bounded buffering, and protocol-level telemetry.
6. Add a gRPC client to the existing TypeScript runner and exercise the full contract before using it from a Rust runtime.
7. Canary opt-in runners, compare v1/v2 correctness and health, then expand gradually while retaining Socket.IO fallback.

Rollback disables new v2 assignments and reconnects eligible TypeScript runners through v1. The server retains deduplication outcomes until all accepted outbox entries have resolved or expired. Schema additions remain inert and can be removed only after the rollback window.

## Open Questions

- The exact retention duration for mutation outcomes and event replay can be tuned from observed retry/backlog distributions after the compatibility harness; the contract only requires it to cover the configured retry window and to signal gaps explicitly.
- Whether generated TypeScript bindings are committed or produced during builds can follow repository release tooling, provided CI verifies deterministic generation.
