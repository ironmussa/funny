## 1. Browser Protocol Foundation

- [x] 1.1 Add an isolated `browser.v1` Protobuf source tree for common metadata, negotiation, operations, application events, interactive messages, and control outcomes without importing privileged `runner.v2` services.
- [x] 1.2 Define generated typed statuses for incompatibility, malformed input, authentication, authorization, deadline, cancellation, conflict, resource exhaustion, gap, and snapshot-required outcomes.
- [x] 1.3 Define request/event identifiers, scope sequences and revisions, causal identifiers, idempotency keys, cursors, delivery classes, resource references, and large-resource references.
- [x] 1.4 Define the initial operation, event, terminal, browser-session, acknowledgement, heartbeat, cancellation, and protocol-control `oneof` payloads selected for migration.
- [x] 1.5 Extend Buf generation to emit isolated browser TypeScript artifacts with domain-level imports and add Rust-compatible descriptors or fixtures without implementing a native adapter.
- [x] 1.6 Add protocol lint, breaking-change, generated-diff, and golden binary/JSON fixture checks to repository tests.

## 2. Socket.IO Binary Carrier

- [x] 2.1 Add stable `browser:v1` carrier event constants and binary envelope codecs around the existing authenticated Socket.IO namespace using its default parser.
- [x] 2.2 Implement payload normalization, decode/schema validation, unknown-message handling, configured size limits, safe typed errors, and no-partial-dispatch behavior.
- [x] 2.3 Implement per-connection version/capability negotiation with generated-schema identity and independently selectable `operations`, `events`, `terminal`, and `browser_session` representations.
- [x] 2.4 Preserve current WebSocket and polling transports, rooms, acknowledgement timeouts, browser same-origin resolution, and packaged-client local-server resolution.
- [x] 2.5 Add carrier compatibility tests for binary attachments in supported browsers, WebViews, WebSocket mode, polling fallback, reconnect, malformed/oversized messages, and production packaging.
- [x] 2.6 Measure encode/decode CPU, payload/frame sizes, bundle impact, latency, and sustained memory against explicit acceptance thresholds while the carrier remains undispatched shadow traffic.

## 3. Transport-Neutral Application Boundaries

- [x] 3.1 Extend `BrowserEventSink` with typed publication scopes and delivery metadata so application services do not depend on Socket.IO event names, rooms, or connection objects.
- [x] 3.2 Add a rollout-aware server sink that routes each client and logical message through exactly one dispatched representation and supports non-dispatching shadow telemetry.
- [x] 3.3 Introduce a client realtime port for lifecycle, negotiation, subscriptions, typed operations, interactive sends, cancellation, recovery, and teardown without exposing Socket.IO types to stores or renderers.
- [x] 3.4 Implement existing legacy Socket.IO behavior behind the new client and server ports and add state/lifecycle parity tests before assigning any binary traffic.
- [x] 3.5 Preserve validated remote-thread origin routing, browser same-origin behavior, and packaged-client endpoint policy through the transport-neutral boundary.

## 4. Authentication and Authorization

- [x] 4.1 Reuse the existing Socket.IO session and origin handshake to derive the principal before activating `browser.v1`; reject unsupported or unauthenticated negotiation safely.
- [x] 4.2 Add per-operation and per-subscription authorization for thread, project, runner, terminal, browser-session, share, and tenant resources while ignoring payload-supplied principal identity.
- [x] 4.3 Terminate or restrict protected subscriptions after session or share revocation within a configured bound and return a typed revocation outcome where disclosure is authorized.
- [x] 4.4 Add regression tests for missing, expired, and revoked sessions; disallowed origins; CSRF-sensitive mutations; identity substitution; cross-user references; and non-disclosing errors.

## 5. Typed Operations and Idempotency

- [x] 5.1 Implement the `browser:v1:operation` request carrier with binary Socket.IO acknowledgements, stable application request IDs, typed outcomes, timeouts/deadlines, and configured concurrency bounds.
- [x] 5.2 Add explicit cancellation control that stops cancellable downstream work independently of Socket.IO acknowledgement timeout.
- [x] 5.3 Implement durable-mutation idempotency storage and conflict detection so retry after a lost acknowledgement returns the original compatible outcome without duplicate mutation.
- [x] 5.4 Add causal/revision metadata so operation outcomes and independently delivered events reconcile once in client state.
- [x] 5.5 Migrate `pty:list` as the first operation canary and verify success, timeout, no-runner, reconnect, binary polling fallback, and legacy rollback parity.
- [x] 5.6 Migrate thread open/close operations with access checks and presence lifecycle parity, including cleanup on disconnect.
- [x] 5.7 Add operation tests for typed errors, deadline propagation, cancellation cleanup, idempotent retry, revision correlation, authorization, and no duplicate execution.

## 6. Sequenced Events and Recovery

- [x] 6.1 Implement authorized user, thread-stream, and thread-presence subscriptions over the `browser:v1:event` carrier using existing Socket.IO room membership semantics.
- [x] 6.2 Add event ID assignment, scoped sequence/revision tracking, bounded retention, cursor acceptance, explicit gap reporting, and snapshot-required scope selection.
- [x] 6.3 Implement client reconnect with backoff/jitter, cursor resume, event-ID deduplication, monotonic revision application, and targeted authoritative resynchronization.
- [x] 6.4 Define and enforce durable, snapshot-recoverable, coalescible, volatile, and at-most-once policy for every migrated event or interactive payload.
- [x] 6.5 Add bounded per-connection and per-class message, byte, and concurrency queues with coalescing, allowed drops, resource-exhausted behavior, and slow-consumer diagnostics.
- [x] 6.6 Migrate one low-volume event domain as a canary without duplicate legacy dispatch, then expand typed event coverage domain by domain behind independent rollout assignment.
- [x] 6.7 Add failure-injection tests for disconnect before/after delivery, duplicates, unavailable cursors, retained replay, snapshot recovery, revocation, polling fallback, and slow consumers.

## 7. Terminal and Browser-Session Traffic

- [x] 7.1 Reserve carrier capacity or priority for cancellation, exit, terminal error, protocol control, and gap outcomes so bulk output and frames cannot starve completion signals.
- [x] 7.2 Map terminal spawn, write, resize, signal, rename, reconnect, restore, close, output, exit, and error behavior to typed interactive messages through existing runner ports.
- [x] 7.3 Enforce at-most-once terminal input across reconnect, latest-wins resize coalescing, ordered output, explicit gaps, and bounded output replay only when retention policy permits it.
- [x] 7.4 Migrate terminal clients by cohort and add parity tests for restored tabs, runner transitions, high-output pressure, polling behavior, disconnect, exit, errors, and rollback.
- [x] 7.5 Map browser-session open, navigation, input, inspection, execute, heartbeat, frame reference, and close behavior to typed interactive messages.
- [x] 7.6 Keep oversized screenshots and frames on authorized bounded HTTP resources and carry only typed references or policy-compliant chunks through Socket.IO.
- [x] 7.7 Migrate browser-session clients independently and test latency, frame pressure, coalescing, heartbeat expiry, reconnect, close, authorization revocation, and rollback.

## 8. Rollout, Observability, and Completion Gates

- [x] 8.1 Add server-controlled rollout policy by protocol version, client/deployment cohort, and traffic class that prevents simultaneous logical dispatch through legacy and binary representations.
- [x] 8.2 Add payload-safe metrics and structured logs for negotiation, selected representation, transport fallback, reconnects, decode failures, operation status/latency, queue pressure, drops, gaps, snapshots, payload sizes, and end-to-end latency.
- [x] 8.3 Define canary acceptance and automatic/manual rollback thresholds for failures, timeouts, reconnects, gaps, latency, memory, queue exhaustion, and state parity.
- [x] 8.4 Exercise independent rollback for operations, events, terminal, and browser-session traffic and verify committed state survives without replaying at-most-once interactive input.
- [x] 8.5 Document local, packaged-client, self-hosted, and managed deployment behavior, diagnostics, feature controls, compatibility windows, and rollback procedures.
- [x] 8.6 Run protocol lint, breaking-change, generation consistency, golden fixtures, unit, integration, browser/WebView, WebSocket/polling, reconnect, authorization, slow-consumer, and failure-injection suites.
- [x] 8.7 Run `bun run lint` and `bun run typecheck` and resolve all failures introduced by the change.
- [x] 8.8 Complete a production-like soak with concurrent operations, events, terminal, browser-session, and runner gRPC traffic under bounded memory and accepted latency.
- [x] 8.9 Set retained-event age/byte budgets and the initial terminal-output recovery policy from canary measurements, retaining explicit snapshot/gap behavior at every setting.
- [x] 8.10 Record the released-client compatibility window and require separate reviewed changes for a custom Socket.IO parser, native WebSocket transport, native gRPC adapters, or legacy Socket.IO retirement.
