# Spec Delta

## ADDED Requirements

### Requirement: Browser-session traffic uses browser.v1 only

The server SHALL deliver every browser-session event to web clients only as a `browser.v1` interactive envelope, regardless of rollout configuration. Browser-session events SHALL NOT be published as legacy Socket.IO events, and there SHALL be no operator setting that returns the browser-session class to a legacy or shadow representation.

#### Scenario: Runner reports a browser-session event

- **WHEN** a runner publishes any browser-session event for its owner
- **THEN** the server SHALL deliver it to that owner's authorized clients as one `browser.v1` envelope and SHALL NOT also emit it as a legacy event

#### Scenario: Operator sets a legacy rollout value

- **WHEN** the server starts with configuration that previously selected legacy or shadow delivery for browser sessions
- **THEN** browser-session events SHALL still be delivered as `browser.v1` and the other traffic classes SHALL keep their configured representation

#### Scenario: Client did not negotiate browser.v1

- **WHEN** a connected client has not completed a compatible `browser.v1` negotiation
- **THEN** the server SHALL NOT deliver browser-session events to that connection, and the client SHALL treat its browser sessions as disconnected until it negotiates

### Requirement: Complete browser-session message set

The `browser.v1` browser-session message SHALL represent every browser-session state the panel relies on: ready (with page URL, viewport and controller), frame, page navigation (URL), viewport change, controller change, pending dialog (or its resolution), agent-opened session, agent pointer position and kind, console, result, status and close. Each message type SHALL declare its delivery class.

#### Scenario: Panel attaches to an existing session

- **WHEN** a panel attaches to a browser session that is already open
- **THEN** it SHALL receive a ready message carrying the current page URL, viewport and controller, and any pending dialog, without depending on a separately routed message

#### Scenario: Page navigates on its own

- **WHEN** the session's page navigates because of a link, redirect, agent action, popup or returning to a previous tab
- **THEN** the client SHALL receive a navigation message with the new URL and the panel SHALL show it, without overwriting a URL the user is editing

#### Scenario: Agent moves the pointer

- **WHEN** the agent performs a mouse action in a session
- **THEN** the client SHALL receive a pointer message with viewport coordinates and kind (move, click, down, up), delivered as volatile so a slow consumer may drop stale positions

#### Scenario: Messages of one session keep their order

- **WHEN** a runner publishes several browser-session events for the same session
- **THEN** the client SHALL receive them in publication order, except volatile or coalescible messages that were dropped or replaced by a newer one

## MODIFIED Requirements

### Requirement: Reversible event-by-event migration and compatibility gate

Legacy Socket.IO events and the versioned binary carrier SHALL coexist during migration for the operation, event and terminal traffic classes, while each logical operation or event type for a client is dispatched through one selected representation. The browser-session traffic class is outside this migration: it is delivered only through `browser.v1`. Production migration SHALL require protocol-fixture, browser, fallback-transport, reconnect, authorization, message-limit, slow-consumer, and state-parity validation plus observable protocol health.

#### Scenario: Event type is assigned to browser.v1

- **WHEN** rollout policy selects the binary representation for a supported client and logical event type
- **THEN** the server SHALL prevent duplicate publication of that logical event through its legacy representation to the same client

#### Scenario: Compatibility gate fails

- **WHEN** binary parsing, generated-code compatibility, polling fallback, browser packaging, or ingress behavior fails a required gate for a migrating traffic class
- **THEN** migration of the affected event types SHALL remain disabled and their legacy Socket.IO representation SHALL remain available

#### Scenario: Canary health regresses

- **WHEN** decode failures, reconnects, gaps, dropped messages, acknowledgement timeouts, latency, or memory exceed configured thresholds for a migrating traffic class
- **THEN** operators SHALL be able to return new clients to legacy event representations for that class without losing committed durable state

#### Scenario: Operator inspects protocol health

- **WHEN** operators inspect client transport diagnostics
- **THEN** they SHALL be able to distinguish protocol version and representation and observe connections, fallbacks, reconnects, decode failures, timeouts, queue pressure, gaps, payload sizes, and end-to-end latency without exposing credentials or payload content

#### Scenario: Browser-session class is not reversible

- **WHEN** an operator asks to return browser-session traffic to its legacy representation
- **THEN** no such setting SHALL exist; recovery SHALL be a server and client redeploy of a previous version
