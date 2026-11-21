# agent-browser-automation Specification

## Purpose

Lets an agent operate a real web browser on the user's runner — open pages, read them, click, type and run scripts — inside the same browser session the user watches in the Browser Panel, so web tasks (dashboards, OAuth logins, checking deployed pages) happen in Funny instead of in a separate or system browser.

## Requirements

### Requirement: Agent browser tool set

Every agent spawn on a runner SHALL have access to a browser tool server bound to the spawn's thread and user. Phase 1 SHALL provide these tools:

| Tool               | Behaviour                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_open`     | Open (or reuse) the thread's browser session and optionally navigate to a URL. Accepts `profile: 'persistent' \| 'ephemeral'` (default `persistent`). |
| `browser_navigate` | Navigate to a URL, or go `back` / `forward` / `reload`.                                                                                               |
| `browser_snapshot` | Return the accessibility snapshot of the current page with element references; optionally include a viewport screenshot.                              |
| `browser_act`      | Perform one action: `click`, `double_click`, `hover`, `type`, `fill`, `select`, `press`, `scroll`, `drag`.                                            |
| `browser_evaluate` | Run a JavaScript expression in the page and return its JSON-serialisable result.                                                                      |
| `browser_wait_for` | Wait for text to appear or disappear, a URL match, a reference to become visible, or a fixed delay, up to a bounded timeout.                          |
| `browser_status`   | Report session state: open/closed, URL, title, viewport, controller, pending dialog, last console errors.                                             |
| `browser_resize`   | Set the viewport size.                                                                                                                                |
| `browser_close`    | Close the thread's browser session.                                                                                                                   |

Phase 2 SHALL add `browser_dialog`, `browser_set_appearance`, `browser_recording_start` and `browser_recording_stop`, and the `upload` action on `browser_act`.

The thread and user a tool acts for SHALL come from the spawn, never from tool arguments.

#### Scenario: Tools available without configuration

- **WHEN** an agent starts on any thread of a user with a connected runner
- **THEN** the browser tools SHALL be callable without the user adding an MCP server

#### Scenario: Model cannot choose another thread

- **WHEN** a tool call includes a `threadId`, `sessionId` or `userId` argument
- **THEN** the argument SHALL be rejected or ignored, and the call SHALL act on the spawn's own thread session

#### Scenario: Scratch threads

- **WHEN** an agent on a scratch thread calls `browser_open`
- **THEN** the session SHALL open exactly as for a project thread

### Requirement: One browser session per thread, shared with the panel

Each thread SHALL have at most one browser session. The agent's tools and the Browser Panel SHALL operate the same session, so the user sees every agent action in real time.

#### Scenario: Agent opens a page

- **WHEN** the agent calls `browser_open { url: "https://dash.cloudflare.com" }` and the user has the thread open
- **THEN** the runner SHALL open or reuse the thread's session and navigate to the URL
- **AND** the client SHALL be notified with the thread id so the Browser Panel can attach to that session and show its frames

#### Scenario: Reuse across turns

- **WHEN** the agent's turn ends and a later turn on the same thread calls `browser_snapshot`
- **THEN** the call SHALL operate on the same session, page and logged-in state

#### Scenario: No session yet

- **WHEN** the agent calls any tool other than `browser_open` or `browser_status` before a session exists
- **THEN** the tool SHALL fail with error `no-browser-session` telling the agent to call `browser_open`

### Requirement: Session isolation by user and thread

A browser tool call SHALL only reach a session owned by the spawn's user and bound to the spawn's thread. Sessions SHALL NOT be shared between users, and a thread SHALL NOT reach another thread's session.

#### Scenario: Another thread's session

- **WHEN** thread A has an open session and an agent on thread B of the same user calls `browser_snapshot`
- **THEN** the call SHALL fail with `no-browser-session` and SHALL NOT read thread A's page

#### Scenario: Panel messages for a foreign session

- **WHEN** a client sends a `browser-session:*` message for a session owned by a different user
- **THEN** the runner SHALL refuse it and SHALL NOT forward input, frames or results

### Requirement: Accessibility snapshot with element references

`browser_snapshot` SHALL return a text accessibility tree of the current page in which every interactive element carries a short reference (e.g. `e12`). The output SHALL include the page URL and title, and SHALL be truncated at a bounded size with an explicit truncation marker.

#### Scenario: Snapshot of a form

- **WHEN** the agent calls `browser_snapshot` on a login page
- **THEN** the result SHALL list the email field, password field and submit button, each with a reference

#### Scenario: Screenshot on request

- **WHEN** the agent calls `browser_snapshot { screenshot: true }`
- **THEN** the result SHALL also contain the current viewport as an image

### Requirement: References expire

Element references SHALL belong to one snapshot generation. A reference SHALL become invalid when the main frame navigates, when a newer snapshot is taken, or when control changes between user and agent. Using an invalid reference SHALL fail with error `stale-ref` and SHALL NOT act on any element.

#### Scenario: Navigation invalidates references

- **WHEN** the agent takes a snapshot, the page navigates, and the agent then calls `browser_act { action: "click", ref: "e5" }`
- **THEN** the call SHALL fail with `stale-ref` telling the agent to take a new snapshot

#### Scenario: Newer snapshot invalidates older references

- **WHEN** the agent takes snapshot 1, then snapshot 2, then acts with a reference that appeared only in snapshot 1
- **THEN** the call SHALL fail with `stale-ref`

### Requirement: Actions by reference or coordinates

`browser_act` SHALL accept either an element reference or viewport coordinates as its target (`drag` takes a source and a destination). After the action the tool SHALL return the resulting URL and title and whether a navigation occurred. Actions SHALL time out after a bounded period with error `action-timeout`.

#### Scenario: Fill and submit

- **WHEN** the agent calls `browser_act { action: "fill", ref: "e3", text: "me@example.com" }` then `browser_act { action: "press", key: "Enter" }`
- **THEN** the field SHALL contain the text and the Enter key SHALL be delivered to the focused element

#### Scenario: Element not actionable

- **WHEN** the referenced element is hidden or disabled for longer than the action timeout
- **THEN** the tool SHALL fail with `action-timeout` and a message naming the reason

#### Scenario: Coordinates

- **WHEN** the agent calls `browser_act { action: "click", x: 200, y: 340 }`
- **THEN** a click SHALL be dispatched at that viewport position

### Requirement: Evaluate returns serialisable results

`browser_evaluate` SHALL evaluate the expression in the page's main frame, await a returned promise, and return a JSON-serialisable value truncated at a bounded size. Exceptions SHALL be returned as error `evaluate-failed` with the exception message.

#### Scenario: Read page data

- **WHEN** the agent calls `browser_evaluate { expression: "document.title" }`
- **THEN** the tool SHALL return the page title

#### Scenario: Page throws

- **WHEN** the expression throws `ReferenceError: foo is not defined`
- **THEN** the tool SHALL fail with `evaluate-failed` including that message

### Requirement: Browser tools follow the thread's permission mode

Browser tool calls SHALL be subject to the thread's tool-permission mode like any other non-Funny MCP tool. They SHALL NOT be auto-approved by the wildcard that auto-approves Funny's internal coordination tools.

#### Scenario: Ask-before-acting mode

- **WHEN** a thread runs in a mode that requires approval for tools and the agent calls `browser_act`
- **THEN** the user SHALL be asked to approve the call before it runs

### Requirement: Agent-owned session lifetime

A session opened by the agent SHALL stay open across agent turns and while the Browser Panel is closed. It SHALL close when the agent calls `browser_close`, when the user closes it from the panel, after a bounded idle period with neither agent tool calls nor an attached panel, when the thread is deleted or archived, or when the runner shuts down.

#### Scenario: Idle reaping

- **WHEN** no browser tool has been called on a thread session and no panel has been attached for the idle period
- **THEN** the runner SHALL close the session with reason `idle`

#### Scenario: Thread deleted

- **WHEN** the user deletes a thread that has an open session
- **THEN** the runner SHALL close that session

#### Scenario: Session limit

- **WHEN** the runner is at its maximum number of sessions and the agent calls `browser_open`
- **THEN** the tool SHALL fail with `too-many-sessions` and name the threads holding sessions

### Requirement: Shared control between user and agent (phase 2)

Every session SHALL have a controller, `agent` or `user`. While the user controls the session, agent tools that change the page (`browser_act`, `browser_navigate`, `browser_evaluate`, `browser_dialog`, `browser_resize`, `browser_set_appearance`) SHALL fail with `user-has-control`; read-only tools (`browser_snapshot`, `browser_status`, `browser_wait_for`) SHALL keep working. The panel SHALL show who controls the session and offer "Take over" and "Hand back to agent".

#### Scenario: User takes over to solve a challenge

- **WHEN** the agent reaches a CAPTCHA or two-factor prompt and the user clicks "Take over"
- **THEN** the controller SHALL become `user`, the agent's references SHALL expire, and agent page-changing calls SHALL fail with `user-has-control` until the user hands back

#### Scenario: Agent asks for help

- **WHEN** a tool result indicates a challenge the agent cannot solve
- **THEN** the agent SHALL be able to read `browser_status` showing `controller: user` after the user takes over, and continue after hand-back

### Requirement: Dialogs (phase 2)

JavaScript dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) SHALL be held as a pending dialog visible in `browser_status` and in the panel. `browser_dialog` SHALL accept or dismiss it, with optional prompt text. Until then, actions SHALL fail with `dialog-pending`. In phase 1, dialogs SHALL be dismissed automatically and reported in the next tool result.

#### Scenario: Confirm dialog

- **WHEN** a click opens `confirm("Delete zone?")` and the agent calls `browser_dialog { accept: true }`
- **THEN** the dialog SHALL be accepted and the page SHALL continue

### Requirement: File upload (phase 2)

`browser_act { action: "upload", ref, paths }` SHALL set files on a file input. Paths SHALL resolve inside the thread's working directory; paths outside it SHALL fail with `path-not-allowed`.

#### Scenario: Upload outside the thread directory

- **WHEN** the agent passes `/etc/passwd`
- **THEN** the tool SHALL fail with `path-not-allowed` and no file SHALL be attached

### Requirement: Appearance and recording (phase 2)

`browser_set_appearance { colorScheme: 'light' | 'dark' }` SHALL emulate the preferred colour scheme for the session. `browser_recording_start` / `browser_recording_stop` SHALL record the session's viewport and, on stop, save a video file attached to the thread and return its location. When the runner cannot encode video, `browser_recording_start` SHALL fail with `recording-unavailable`.

#### Scenario: Dark mode check

- **WHEN** the agent calls `browser_set_appearance { colorScheme: "dark" }`
- **THEN** `matchMedia('(prefers-color-scheme: dark)').matches` SHALL be `true` in the page

#### Scenario: Record a flow

- **WHEN** the agent starts a recording, performs three actions, and stops it
- **THEN** a video of the viewport covering those actions SHALL be attached to the thread

### Requirement: URLs opened by agent processes open in the thread session (phase 2)

Commands the agent runs SHALL see a `BROWSER` environment variable that opens the given URL in the thread's browser session (opening one if needed) and notifies the client, instead of launching a system browser.

#### Scenario: CLI login flow

- **WHEN** an agent-run CLI that honours `$BROWSER` opens an OAuth login URL
- **THEN** the URL SHALL load in the thread's browser session shown in the panel
- **AND** a redirect to `http://localhost:<port>` on the runner SHALL reach the CLI's local callback server

### Requirement: Browser tool cards

The thread view SHALL render browser tool calls as readable cards showing the action, its target (reference label or coordinates), the resulting URL, errors in plain language, and — when the result contains a screenshot — a thumbnail. Each card SHALL offer "Show in panel" that opens the Browser Panel attached to the thread's session.

#### Scenario: Click card

- **WHEN** the agent calls `browser_act { action: "click", ref: "e7" }` on a button labelled "Create token"
- **THEN** the card SHALL read like "Click "Create token"" and show the resulting URL
