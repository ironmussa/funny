## Purpose

Defines an experimental native GPUIX client that provides a secure, usable, and state-consistent Funny project and agent-thread workflow without depending on the DOM renderer.

## ADDED Requirements

### Requirement: Explicit experimental renderer selection

The application SHALL launch the GPUIX client only through an explicit renderer selection and SHALL keep the existing React DOM renderer as the default until the native client satisfies its acceptance gates.

#### Scenario: Default launch

- **WHEN** a user launches Funny without selecting a renderer
- **THEN** the application SHALL launch the existing React DOM renderer

#### Scenario: Native launch

- **WHEN** a user selects the GPUIX renderer on a supported host
- **THEN** the application SHALL launch the native client against the same configured Funny server

#### Scenario: Unsupported native host

- **WHEN** the GPUIX renderer is selected on a host without a compatible native binary
- **THEN** startup SHALL fail with an actionable unsupported-host message and SHALL identify the React DOM renderer as the available fallback

### Requirement: Authenticated native bootstrap

The native client SHALL establish and restore an authenticated Funny session using the existing server authentication contract without persisting plaintext credentials.

#### Scenario: Restore valid session

- **WHEN** the native client starts with a valid persisted session
- **THEN** it SHALL restore the session and load the authenticated application without prompting for credentials

#### Scenario: Authenticate with credentials

- **WHEN** a user submits valid credentials in the native login view
- **THEN** the client SHALL establish the server session, retain only the session material required by the transport, and continue to project loading

#### Scenario: Expired or rejected session

- **WHEN** a restored session is expired or the server returns an authentication failure
- **THEN** the client SHALL clear unusable session material, stop authenticated realtime processing, and return to the login view with an actionable message

### Requirement: Project and thread navigation

An authenticated native client SHALL list accessible projects and thread groups, identify active thread states, and navigate to a selected thread using the same access restrictions and route semantics as the existing client.

#### Scenario: Load accessible navigation

- **WHEN** authenticated bootstrap completes
- **THEN** the client SHALL display the user's accessible projects, project threads, scratch threads, and shared threads without exposing inaccessible resources

#### Scenario: Select a thread

- **WHEN** a user selects a thread from native navigation
- **THEN** the client SHALL update its current location, load that thread's state and messages, and subscribe to its live updates

#### Scenario: Resource becomes inaccessible

- **WHEN** the server denies access to the current project or thread
- **THEN** the client SHALL remove stale protected content from the active view and return to an accessible navigation state

### Requirement: Equivalent virtualized thread presentation

The native thread view SHALL preserve message order and render the conversation features required for agent work while retaining only a bounded visible window for long histories.

#### Scenario: Render a loaded thread

- **WHEN** a thread containing user, assistant, tool-call, Markdown, code, table, and diff content loads
- **THEN** the native view SHALL display each supported item in canonical order with stable identities and distinguish its semantic role and execution state

#### Scenario: Navigate a long history

- **WHEN** a user scrolls through a thread with at least 500 messages
- **THEN** the native view SHALL virtualize off-screen rows, preserve scroll continuity as row heights resolve, and allow older pages to load without duplicating or reordering messages

#### Scenario: Unsupported message feature

- **WHEN** a message contains a feature the native renderer cannot display safely
- **THEN** the view SHALL render an explicit stable fallback containing the feature type and available textual content rather than silently omitting the item

### Requirement: Prompt and agent lifecycle controls

The native thread client SHALL submit prompts through the existing thread API and SHALL expose the minimum controls needed to observe, stop, resume, and answer an agent run.

#### Scenario: Submit a prompt

- **WHEN** a user submits non-empty prompt text to a writable thread
- **THEN** the client SHALL create the user turn once, transition the thread into its server-confirmed active state, and prevent duplicate submission while the request is unresolved

#### Scenario: Stop an active run

- **WHEN** a user requests stop for an active agent run
- **THEN** the client SHALL send the existing stop command, preserve already received output, and reflect the server-confirmed terminal state

#### Scenario: Resume a waiting run

- **WHEN** an agent is waiting for user input and the user supplies a response
- **THEN** the client SHALL send the response through the existing resume path and continue rendering the same run's events

### Requirement: Realtime ordering and recovery

The native client SHALL apply the same renderer-independent realtime transitions as the web client and SHALL recover state after connection loss without duplicating durable messages or tool calls.

#### Scenario: Stream an active response

- **WHEN** ordered realtime deltas arrive for the selected thread
- **THEN** the client SHALL update the corresponding assistant turn and tool calls incrementally while keeping unrelated thread state isolated

#### Scenario: Reconnect after interruption

- **WHEN** realtime connectivity returns after an interruption
- **THEN** the client SHALL resynchronize eligible active threads through the shared reconnect policy before presenting them as current

#### Scenario: Late or duplicate event

- **WHEN** a duplicate or stale event arrives after durable state has advanced
- **THEN** the client SHALL preserve the canonical durable ordering and SHALL NOT create a duplicate user message, assistant message, or tool call

### Requirement: Native permission approval

The native client SHALL display pending agent permission requests with their risk-relevant context and SHALL send exactly one explicit user decision through the existing permission response contract.

#### Scenario: Approve a request

- **WHEN** a pending permission request is active and the user approves it
- **THEN** the client SHALL send one approval associated with the correct thread, run, and request and SHALL disable further responses for that request

#### Scenario: Deny a request

- **WHEN** a user denies a pending permission request
- **THEN** the client SHALL send one denial, preserve the request outcome in the thread view, and SHALL NOT execute the requested action locally

#### Scenario: Stale request

- **WHEN** a permission request expires or is superseded before the user responds
- **THEN** the client SHALL disable its controls and reconcile with the current server state

### Requirement: Evidence-bounded native acceptance

The GPUIX client SHALL pass functional parity checks for the MVP and controlled renderer benchmarks before it can become the default renderer; unavailable native telemetry SHALL remain explicit rather than being inferred from mutation timing.

#### Scenario: MVP acceptance

- **WHEN** the native client is evaluated for wider rollout
- **THEN** authentication, navigation, fixture inventory, final state, prompt, realtime, stop/resume, permission, crash recovery, and long-thread memory checks SHALL pass on every supported release host

#### Scenario: Insufficient presentation evidence

- **WHEN** the pinned GPUIX API does not expose a verified presentation boundary or raw frame timings
- **THEN** interaction and frame-performance acceptance SHALL remain inconclusive and mutation completion SHALL NOT be labeled as presentation latency
