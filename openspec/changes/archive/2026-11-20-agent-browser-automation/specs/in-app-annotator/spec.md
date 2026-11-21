# Spec Delta

## MODIFIED Requirements

### Requirement: Browser session lifecycle binds to panel open/close

The Browser Panel SHALL maintain at most one active browser session per panel-open. A session is either **panel-owned** (opened by the user from the panel without a thread binding) or **thread-bound** (opened by an agent, or attached by the panel to the active thread's session).

For panel-owned sessions, opening the panel and submitting a URL SHALL open a session; closing the panel (via the toggle, the close button, or unmount) SHALL close the session. If the user submits a different URL while the panel is open, the session is reused via `Page.navigate`.

For thread-bound sessions, closing the panel SHALL only detach the panel; the session SHALL stay open under the lifetime rules of the `agent-browser-automation` capability. The panel SHALL offer an explicit "Close browser session" action that closes a thread-bound session.

#### Scenario: Panel closes → session closes

- **WHEN** the user clicks the globe icon while the panel is open with a live panel-owned (not thread-bound) session
- **THEN** the client SHALL send `browser-session:close { sessionId }` to the runner
- **AND** the runner SHALL close the session's page and release it
- **AND** a `browser_session.closed` counter SHALL be recorded with `reason: 'user'`

#### Scenario: Panel closes → thread-bound session stays open

- **WHEN** the user closes the panel while it is attached to a thread-bound session
- **THEN** the client SHALL send `browser-session:detach { sessionId }` and the session SHALL remain open
- **AND** reopening the panel on the same thread SHALL reattach and resume frames

#### Scenario: Heartbeat lost → session reaped

- **WHEN** the runner has not received a heartbeat from the client for 90 seconds for a panel-owned session
- **THEN** the runner SHALL force-close the session
- **AND** `browser_session.closed` SHALL be recorded with `reason: 'heartbeat'`

#### Scenario: Heartbeat lost → thread-bound session detaches

- **WHEN** the heartbeat is lost for a thread-bound session
- **THEN** the runner SHALL mark the panel detached and SHALL NOT close the session

#### Scenario: Runner restart

- **WHEN** the runner restarts while a session is live
- **THEN** the client SHALL detect the WebSocket disconnect and show a "Browser session disconnected — reconnect?" affordance
- **AND** clicking reconnect SHALL open a fresh session at the previous URL with empty annotations preserved

## ADDED Requirements

### Requirement: Panel attaches to the active thread's browser session

When the active thread has a thread-bound browser session, the Browser Panel SHALL attach to it instead of opening a new one. When an agent opens a session on the active thread, the client SHALL surface it (open or badge the panel) so the user can watch.

#### Scenario: Agent opens a page while the user views the thread

- **WHEN** the agent on the active thread opens a browser session
- **THEN** the panel SHALL show that session's frames with a label naming the thread

#### Scenario: Switching threads

- **WHEN** the user switches from a thread with a session to a thread without one
- **THEN** the panel SHALL detach from the first session without closing it

### Requirement: Persistent per-user browser profile

Browser sessions SHALL use a persistent browser profile stored on the runner per user, so cookies, local storage and logins survive across sessions and runner restarts. A session MAY be opened as ephemeral, in which case its cookies and storage SHALL be discarded when it closes and SHALL NOT be visible to persistent sessions. The profile directory SHALL be readable only by the runner's OS user. The panel SHALL offer an action to clear the persistent profile.

#### Scenario: Login survives

- **WHEN** the user logs into a site in a session, closes it, and later opens a new persistent session
- **THEN** the site SHALL still be logged in

#### Scenario: Ephemeral session

- **WHEN** a session is opened with `profile: 'ephemeral'` and logs into a site
- **THEN** a persistent session SHALL NOT see that login, and the login SHALL be gone after the ephemeral session closes

#### Scenario: Clear profile

- **WHEN** the user clears the browser profile from the panel
- **THEN** all open sessions SHALL close and the profile's cookies and storage SHALL be deleted

### Requirement: Browser reports a regular Chrome user agent

The runner's headless browser SHALL report a user agent of the form `Chrome/<major>.0.0.0` matching its real version, without the `HeadlessChrome` token, for page requests and `navigator.userAgent`.

#### Scenario: User agent check

- **WHEN** a page evaluates `navigator.userAgent`
- **THEN** the value SHALL NOT contain `HeadlessChrome` and SHALL contain `Chrome/<major>` of the running browser
