## 1. Pre-refactor characterization gates

- [x] 1.1 Build a reusable in-process fixture that connects the production TypeScript runner client and team transport to the real server gRPC endpoint on ephemeral ports
- [x] 1.2 Add vertical characterization cases for control, data operation, event, HTTP tunnel, and terminal traffic through the production adapters
- [x] 1.3 Add an ambiguous-commit test that drops the mutation outcome, restarts from the same durable outbox, and proves one application plus eventual confirmation
- [x] 1.4 Add a static no-legacy fitness check for runner Socket.IO namespaces, removed configuration, runtime Socket.IO dependencies, and direct runner HTTP routing
- [x] 1.5 Run the existing focused suites and compatibility harnesses to establish the protected pre-refactor baseline

## 2. Server capability ports and composition

- [x] 2.1 Define narrow `RunnerRequestPort`, `RunnerTerminalPort`, `RunnerPresencePort`, and `BrowserEventSink` contracts without importing gRPC, protobuf, Hono, or Socket.IO concrete types
- [x] 2.2 Add deterministic contract-test fakes and shared behavioral suites for request, terminal, presence, and browser event ports
- [x] 2.3 Adapt the gRPC tunnel and terminal dispatchers to the request and terminal ports without changing framing, deadlines, cancellation, or error mapping
- [x] 2.4 Make the gRPC session registry the authoritative `RunnerPresencePort` and remove duplicated runner/user maps from the browser relay
- [x] 2.5 Convert the browser relay into a Socket.IO-backed `BrowserEventSink` with its existing room and single-delivery semantics
- [x] 2.6 Create an explicit server composition object that wires the endpoint, runner ports, and browser event sink and owns their lifecycle

## 3. Server consumer migration

- [x] 3.1 Inject `RunnerRequestPort` into the Hono proxy factory and remove its concrete `ws-relay`/`ws-tunnel` dependencies
- [x] 3.2 Inject `RunnerTerminalPort` and runner resolution collaborators into browser PTY handlers, including PTY list, while preserving tenant checks and browser errors
- [x] 3.3 Inject `RunnerRequestPort` into browser-session handlers while preserving signed forwarded identity
- [x] 3.4 Route runner readiness/status consumers through `RunnerPresencePort`
- [x] 3.5 Remove the global gRPC browser-transport registry after all consumers use composition-root injection
- [x] 3.6 Rename remaining transport-neutral `ws-*` runner modules and imports to runner request/browser event terminology
- [x] 3.7 Replace affected process-global module mocks with constructed port fakes and verify test isolation when files run together

## 4. Runtime boundary extraction

- [x] 4.1 Extract HTTP registration and device-link bootstrap into `RunnerEnrollmentClient` behind the existing team-client facade
- [x] 4.2 Extract endpoint validation, connection activation, reconnect callbacks, and shutdown into `RunnerConnectionSupervisor`
- [x] 4.3 Move application-operation/protobuf conversion into a typed gRPC operations adapter with exhaustive request and outcome mapping tests
- [x] 4.4 Extract replayable application-event publication and receipt handling into `RunnerEventPublisher`
- [x] 4.5 Extract control command execution and cancellation into `RunnerControlDispatcher`
- [x] 4.6 Extract local HTTP tunnel framing/dispatch into `RunnerTunnelAdapter`
- [x] 4.7 Extract terminal command, output sequencing, and replay behavior into `RunnerTerminalAdapter`
- [x] 4.8 Reduce `GrpcTeamTransport` to composition of the five stream adapters over the shared runner client and connection lifecycle

## 5. Runtime remote-data facade decomposition

- [x] 5.1 Move thread/message/queue remote functions and caches into a cohesive remote thread data client
- [x] 5.2 Move project/profile/provider remote functions and caches into cohesive remote project and identity clients
- [x] 5.3 Move permissions, watchers, and jobs remote functions into cohesive domain clients
- [x] 5.4 Keep temporary team-client compatibility exports as thin delegates and migrate internal callers by domain group
- [x] 5.5 Remove unused compatibility exports after an import audit and add architecture checks preventing new imports of the monolithic facade

## 6. Vertical, failure, and operational assurance

- [x] 6.1 Add a browser Socket.IO → server port → real gRPC runner → browser response test for PTY and browser-session flows
- [x] 6.2 Add a runner event → real gRPC server → browser Socket.IO delivery test with owner/sharee single-delivery assertions
- [x] 6.3 Add a two-user/two-runner vertical isolation suite covering proxy, terminal, event, and session routing
- [x] 6.4 Add real-adapter failure cases for invalid credentials, incompatible protocol, missing endpoint, listener disabled, session replacement, deadline, cancellation, and reconnect
- [x] 6.5 Add a scheduled 15–30 minute soak/chaos profile with repeated disconnects, half-open or stalled streams, slow consumers, and bounded RSS/backlog assertions
- [x] 6.6 Update CI so fast characterization/contract tests run on pull requests and the extended soak runs on a scheduled or manually dispatched job

## 7. Documentation and final gates

- [x] 7.1 Update OpenWiki diagrams and the gRPC runbook with the port/adapter composition, ownership boundaries, and test layers
- [x] 7.2 Run all focused server/runtime tests, production vertical tests, Rust compatibility, sustained-load, and ingress harnesses
- [x] 7.3 Run `bun run lint`, `bun run typecheck`, architecture fitness checks, and `git diff --check`
- [x] 7.4 Validate the OpenSpec change and confirm no global transport locator, duplicated presence registry, forbidden presentation-to-gRPC import, or runner-v1 surface remains
