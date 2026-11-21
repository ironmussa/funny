## Context

See [proposal.md](proposal.md) for motivation. The completed gRPC-only migration preserved behavior, but transport concerns remain distributed across several layers:

- `runtime/services/team-client.ts` owns HTTP enrollment, mutable connection state, dozens of remote persistence functions, caches, event forwarding, control dispatch, and local tunnel/terminal integration.
- `GrpcTeamTransport` maps application operations and manages operation, event, tunnel, terminal, and control stream behavior in one class.
- Server browser handlers resolve runners and obtain concrete gRPC dispatchers through a global registry.
- `ws-relay.ts` combines browser Socket.IO publication with a second runner-presence index even though the gRPC session registry is the authoritative connection state.
- Several tests rely on process-global `mock.module`, which obscures dependencies and can leak mocks between files.

The public HTTP and browser Socket.IO contracts, runner.v2 protobuf, durable stores, authorization rules, and HTTP enrollment bootstrap must remain unchanged. gRPC remains the only runner data-plane implementation.

## Goals / Non-Goals

**Goals:**

- Make presentation and application code depend on narrow capability ports rather than gRPC classes, global registries, or Socket.IO modules.
- Establish production-shaped characterization coverage before moving responsibilities.
- Keep every refactor step behavior-preserving, independently testable, and reversible.
- Give each gRPC communication class an isolated adapter with shared connection supervision.
- Replace process-global module mocking with explicit construction and deterministic fakes where the affected boundary is migrated.
- Prevent runner-v1 surfaces from being reintroduced.

**Non-Goals:**

- Supporting multiple runner protocols or dynamically selecting transports.
- Reintroducing Socket.IO or direct HTTP runner routing.
- Changing protobuf messages, database schemas, public routes, browser events, enrollment, or deployment configuration.
- Rewriting all runtime repositories or all server dependency construction in one pass.
- Adding a dependency-injection framework.

## Decisions

### Characterize the vertical production path before structural edits

The first gate will join the real TypeScript `RunnerGrpcClient`/`GrpcTeamTransport` to the real server gRPC endpoint in-process. It will exercise one representative path for operations, events, tunnels, terminals, and control, including browser-facing adapters where practical. A second scenario will commit a durable mutation, suppress its response, reconnect from the same outbox, and prove exactly-once application plus eventual outbox confirmation.

Unit tests and the Rust compatibility harness remain valuable, but neither currently connects both production TypeScript adapters. Refactoring before this gate was rejected because passing isolated mocks would not detect a wiring regression.

### Use capability-oriented Ports and Adapters

Consumers will receive small ports based on what they need, not a generic multi-protocol `RunnerTransport`:

```text
HTTP / browser Socket.IO
          |
          v
  RunnerRequestPort       RunnerTerminalPort
  RunnerPresencePort      BrowserEventSink
          |                       |
          +-----------+-----------+
                      v
               gRPC adapters
```

Initial server ports:

- `RunnerRequestPort`: availability and tunneled request dispatch.
- `RunnerTerminalPort`: availability, terminal dispatch, and session listing.
- `RunnerPresencePort`: runner/user readiness from the authoritative gRPC session registry.
- `BrowserEventSink`: user, thread-stream, thread-presence, and global browser publication.

Socket.IO handlers and Hono proxy factories will accept only the ports they use. A plain composition object in the server startup root will construct the production gRPC and Socket.IO adapters. A DI container was rejected as unnecessary indirection.

### Keep gRPC as the single adapter

This design applies the Adapter pattern but does not implement Strategy-based protocol selection. There is one production implementation for every runner-facing port. Interfaces exist to protect application boundaries and enable contract tests, not to speculate about future transports.

### Apply Branch by Abstraction

Existing exports remain as compatibility facades while consumers move incrementally:

1. Introduce a port beside the current concrete service.
2. Wrap the existing gRPC implementation without changing behavior.
3. Add contract tests for the port.
4. Inject the port into one consumer group.
5. Remove the old access path only after all callers migrate.

This avoids a flag day and permits rollback at each consumer boundary. Maintaining two behavioral implementations was rejected; facades delegate to the same gRPC adapter throughout.

### Split server presence from browser publication

The active gRPC session registry will be the single source of runner presence. `ws-relay.ts` will become a browser-only event adapter and will no longer own runner maps. Readiness and routing will query `RunnerPresencePort`, eliminating duplicated connection state and misleading WebSocket terminology.

### Replace the global browser transport registry with composition-root injection

The module-level tunnel/terminal dispatcher locator will be retired after proxy and browser handlers accept their ports through factories. The server endpoint will expose adapters to the composition root, which wires them into HTTP and Socket.IO setup. Shutdown remains owned by the endpoint lifecycle.

### Split runtime responsibilities behind a compatibility facade

The public functions currently exported by `team-client.ts` remain temporarily stable while implementation moves into:

- `RunnerEnrollmentClient` for HTTP registration/device-link bootstrap.
- `RunnerConnectionSupervisor` for endpoint validation, start, reconnect state, and shutdown.
- Domain-grouped remote data clients for threads/messages, projects/profile, permissions, watchers/jobs, and queues.
- `RunnerEventPublisher` for replayable application events.
- `RunnerControlDispatcher` for server commands.
- `RunnerTunnelAdapter` and `RunnerTerminalAdapter` for their respective stream classes.

The facade owns no protocol mapping; it delegates to these collaborators until call sites can import narrower services directly.

### Isolate protobuf translation in an anti-corruption layer

Application operation names and domain payloads will be converted to/from generated runner.v2 messages in the gRPC operations adapter. Tunnel, terminal, event, and control codecs stay with their stream adapters. Application services must not import generated protobuf types or `FailureCode`.

Large switches may first be moved unchanged, then made exhaustively typed in a later mechanical step. Combining movement and semantic remapping was rejected because it would make regression diagnosis difficult.

### Use three test layers around the ports

- Characterization tests protect current end-to-end behavior before refactoring.
- Port contract tests run against deterministic fakes and the gRPC adapter where applicable.
- Production vertical tests verify real composition, authentication, tenant isolation, reconnect, and browser bridging.

A fitness check will reject legacy runner namespace/config/dependency symbols and direct imports from presentation modules into concrete gRPC handlers. A scheduled 15–30 minute soak will add repeated disconnects, half-open streams, slow consumers, and memory/backlog assertions without slowing the normal pull-request suite.

## Risks / Trade-offs

- [Interfaces reproduce the existing monolith] → Keep ports capability-oriented and apply interface segregation; do not expose all runner functions through one object.
- [Facade becomes permanent] → Track caller migration explicitly and include facade reduction/removal tasks with import audits.
- [Duplicate presence sources diverge during migration] → Make the gRPC session registry authoritative first; compatibility functions delegate to it instead of maintaining a second map.
- [Moving stream code changes retry semantics] → Move code without semantic edits under characterization tests, then type/refine it in separate commits.
- [Vertical tests become flaky because they bind ports and use timers] → Allocate ephemeral ports, inject clocks/backoff where possible, use event-based readiness, and reserve process-level soak for scheduled CI.
- [Too many mocks hide integration defects] → Prefer constructed fakes implementing ports and retain at least one real-adapter vertical path per capability.
- [More files increase navigation cost] → Organize by capability and keep composition explicit; the aim is cohesive modules, not maximum file count.

## Migration Plan

1. Add the real-adapter vertical characterization suite, ambiguous-commit restart scenario, and static no-legacy guard. Do not refactor until these pass.
2. Introduce server ports and adapters, make the gRPC session registry authoritative for presence, and add port contracts.
3. Inject request and terminal ports into the proxy and browser handlers; remove the global dispatcher locator and runner state from the browser relay.
4. Introduce runtime collaborators behind the existing team-client facade, beginning with enrollment/connection lifecycle and then moving one stream class at a time.
5. Move operation/protobuf translation into the operations adapter and divide remote data functions by domain group.
6. Add the complete browser-to-runner vertical scenarios, two-user isolation scenario, and adapter fault matrix.
7. Add the scheduled soak/chaos job, enforce architecture import rules, audit compatibility facades, and update OpenWiki diagrams.

Rollback is commit/phase based: each migrated consumer can return to the compatibility facade because both paths delegate to the same gRPC implementation. Durable outboxes and server idempotency records are never transformed or deleted by this refactor.
