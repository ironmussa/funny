# in-app-annotator Specification

## Purpose

TBD - created by archiving change in-app-annotator-panel. Update Purpose after archive.

## Requirements

### Requirement: Globe icon toggles the browser panel from the sidebar header

The system SHALL render a globe icon button in `SidebarTopBar` alongside the existing Search / Kanban / Grid / Analytics icons. Clicking the icon SHALL toggle the visibility of a side panel called the Browser Panel. The icon MUST carry `data-testid="sidebar-browser-panel"`.

#### Scenario: First open

- **WHEN** the user clicks the globe icon while the panel is closed
- **THEN** the Browser Panel SHALL open as a sibling column to the main content with a default width of 480px
- **AND** a `browser_panel.opened` counter metric SHALL be recorded

#### Scenario: Toggle closed

- **WHEN** the user clicks the globe icon while the panel is open
- **THEN** the panel SHALL close
- **AND** all in-memory annotations and the typed URL SHALL be cleared

#### Scenario: Icon hidden when sidebar is collapsed

- **WHEN** the sidebar is in the collapsed state
- **THEN** the globe icon SHALL NOT be rendered in the collapsed strip
- **AND** the panel SHALL remain reachable by expanding the sidebar first

### Requirement: URL bar loads any user-pasted URL into the iframe

The URL input + Go button SHALL trigger a new browser session on the user's runner rather than setting an iframe `src`. Submitting (Enter or Go) SHALL call the runner via WebSocket to (a) spawn or reuse a Chromium subprocess with `--remote-debugging-port=<allocated>`, (b) connect a `ChromeSession` instance, and (c) navigate the page to the URL. The viewport SHALL render the JPEG frame stream from CDP `Page.screencastFrame`, not an `<iframe>`.

The previous "site refuses to be embedded" scenario is REMOVED — any URL the user's runner can reach loads, because the user is now driving a real Chromium, not a browser-sandboxed iframe.

#### Scenario: Cold start

- **WHEN** the user submits a URL for the first time after opening the panel
- **THEN** the runner SHALL spawn a Chromium subprocess and connect a CDP session
- **AND** a `browser_session.opened` counter metric SHALL be recorded
- **AND** the panel SHALL display a "Spawning Chrome…" spinner until the first frame arrives (typically 1.5-2 s)

#### Scenario: Subsequent navigations

- **WHEN** the user submits a new URL while a session is already live
- **THEN** the runner SHALL reuse the existing `ChromeSession` and call `Page.navigate(url)` — no new subprocess
- **AND** the next frame SHALL render the new page

#### Scenario: Invalid scheme prepend

- Unchanged from v1: if the input lacks `://`, prefix with `http://` before forwarding to `Page.navigate`.

### Requirement: Tool selector switches between Browse, Pin, Region, and Draw

The four tools (Browse, Pin, Region, Draw) SHALL remain. The semantic change is that **only Browse forwards mouse events to the streamed Chrome** — Pin / Region / Draw intercept input on the client side, talk to the runner via CDP `Runtime.evaluate` for inspect / capture, and never dispatch the click to the real page.

#### Scenario: Browse mode forwards input to Chrome

- **WHEN** the active tool is Browse and the user clicks at canvas coords (cx, cy)
- **THEN** the client SHALL scale (cx, cy) from canvas pixels to viewport pixels and send `browser-session:input { kind: 'click', x, y }`
- **AND** the runner SHALL call `ChromeSession.dispatchMouseEvent({ type: 'mousePressed' / 'mouseReleased', ... })`
- **AND** the next frame SHALL reflect any DOM change the click caused

#### Scenario: Pin / Region / Draw tools never dispatch clicks to Chrome

- **WHEN** the active tool is Pin, Region, or Draw and the user interacts with the canvas
- **THEN** the client SHALL handle the interaction locally (Pin) or via `browser-session:inspect-at` (no real click) (Region / Pin)
- **AND** the real Chrome page SHALL NOT receive a `mousePressed` event for that interaction
- **AND** annotations created this way carry both viewport coordinates AND DOM element metadata (when available)

### Requirement: Pin tool drops a numbered marker with a note

When the Pin tool is active, a click on the canvas SHALL trigger `browser-session:inspect-at { x, y }` on the runner. The runner SHALL evaluate `document.elementFromPoint(x, y)` in the page context and return an element descriptor. The resulting annotation SHALL carry both `(x, y)` AND the element descriptor (`selector`, `testid`, `tagName`, `text`, `classes`, `boundingBox`, `computedStyles`, `accessibility`, optional `componentName`).

#### Scenario: Element found

- **WHEN** the user clicks at canvas coords (cx, cy) with Pin active and the underlying DOM has a non-null `elementFromPoint`
- **THEN** the annotation SHALL include a non-null `dom` field with at minimum `{ selector, tagName, boundingBox }`
- **AND** a `browser_panel.annotation_added` counter SHALL be recorded with attributes `{ kind: 'pin', has_dom: true }`

#### Scenario: Element not found (empty page region)

- **WHEN** `elementFromPoint(x, y)` returns null (clicked into empty space outside any element)
- **THEN** the annotation SHALL still be created with `(x, y)` but `dom` SHALL be `undefined`
- **AND** the `has_dom: false` attribute is recorded on the metric

### Requirement: Region tool draws a rectangle with a note

When the Region tool is active and the user finishes a drag, the client SHALL send `browser-session:inspect-rect { x, y, w, h }`. The runner SHALL return up to 10 distinct DOM elements whose bounding boxes intersect the rectangle, ordered by area-of-intersection desc. The annotation SHALL store the rectangle coords AND the candidate element descriptors.

#### Scenario: Region encloses one obvious element

- **WHEN** the user drags a rectangle that encloses exactly one prominent element (e.g., a Card component)
- **THEN** the annotation's `dom.elements` array SHALL include that element first
- **AND** when the markdown is rendered, the agent sees both "user marked this rectangle" AND "the element they're talking about is `.card-signup`"

### Requirement: Draw tool produces a free-hand canvas overlay

When the Draw tool is active, the system SHALL render a canvas sized to the overlay that captures pointer input as free-hand strokes. The user SHALL be able to choose one of five colors (red `#ef4444`, amber `#f59e0b`, green `#22c55e`, blue `#3b82f6`, white `#ffffff`) via swatches.

The Draw tool SHALL contribute at most one annotation of kind `draw` per send. Multiple stroke sessions accumulate onto the same canvas. The note for the draw annotation SHALL be entered in a single textarea visible below the color swatches.

#### Scenario: Make a stroke

- **WHEN** the user presses, moves, and releases the mouse with Draw active and red selected
- **THEN** a red stroke SHALL be drawn on the canvas
- **AND** the draw annotation SHALL exist in the store with the current canvas serialized lazily on send

#### Scenario: Clear drawing

- **WHEN** the user clicks the Clear button in the Draw tool's submenu
- **THEN** the canvas SHALL be cleared
- **AND** any pending draw annotation SHALL be removed from the store

### Requirement: Annotation list shows and allows removal of all annotations

The system SHALL render an Annotation List below or beside the iframe that displays each annotation with its number, kind, summary (coords or "drawing"), and a snippet of its note. Each row SHALL include a remove button with `data-testid="browser-panel-annotation-remove-<id>"`.

#### Scenario: Remove an annotation

- **WHEN** the user clicks the remove button for annotation 2
- **THEN** annotation 2 SHALL be deleted from the store
- **AND** the corresponding overlay marker SHALL disappear
- **AND** subsequent annotations SHALL renumber to maintain a 1-based contiguous sequence

### Requirement: Send creates a new thread with structured annotation context

The system SHALL render a Send button with `data-testid="browser-panel-send"` that is enabled when (a) the URL has been loaded successfully AND (b) at least one annotation exists. Clicking Send SHALL open a confirmation dialog with project, mode, and model selectors, defaulting to the user's last-used project (or the first project if none), `mode = 'local'`, and `model = 'sonnet'`.

Confirming the dialog SHALL call `threadsApi.createThread` with:

- `title = "Annotated: <url>"` truncated to 80 characters
- `prompt = ` the structured markdown produced by `lib/browser-panel-markdown.ts`
- `images = ` one image attachment per non-empty draw annotation (PNG `dataUrl` from the canvas)
- `projectId`, `mode`, `model` from the dialog's selections

On success the system SHALL navigate to the new thread, close the panel, and clear the in-memory annotations and URL.

#### Scenario: Send with mixed annotations

- **WHEN** the user clicks Send with one pin, one region, and one non-empty draw annotation, then confirms the dialog
- **THEN** `threadsApi.createThread` SHALL be called with one image attachment and a prompt containing three annotation sections
- **AND** a `browser_panel.sent` counter SHALL be recorded with attribute `annotation_count="3"`
- **AND** the panel SHALL close and the user SHALL be navigated to the new thread route

#### Scenario: Send with no project selected and no projects exist

- **WHEN** the user has zero projects and tries to Send
- **THEN** the Send dialog SHALL display "Create a project first" and the Confirm button SHALL be disabled

#### Scenario: Send fails

- **WHEN** `threadsApi.createThread` rejects
- **THEN** an `error`-level log SHALL be emitted in namespace `browser-panel`
- **AND** the panel SHALL remain open with annotations intact
- **AND** the dialog SHALL show a toast with the error message

### Requirement: Annotation state is ephemeral

The system SHALL hold the panel's URL, tool selection, draw color, and annotation list in a Zustand store (`useBrowserPanelStore`). This state SHALL NOT be persisted to the database, to localStorage, or to any backend. The state SHALL be cleared whenever the panel transitions from open to closed and whenever a Send call resolves successfully.

#### Scenario: Reload clears annotations

- **WHEN** the user creates two annotations and reloads the page
- **THEN** the panel SHALL open empty (no annotations, no URL prefilled) on next icon click

#### Scenario: Close clears annotations

- **WHEN** the user creates one annotation and closes the panel
- **THEN** reopening the panel SHALL show no annotations and an empty URL field

### Requirement: Panel uses shadcn/ui components and respects font-size settings

All interactive elements in the panel SHALL be built from `@/components/ui/*` (Button, Input, Popover, Dialog, ScrollArea, Tooltip, Select). The panel MUST NOT introduce raw HTML buttons, inputs, or third-party UI libraries. Text inside the panel SHALL respect the global font-size setting via the existing `PROSE_FONT_SIZE_PX` / `MONO_FONT_SIZE_PX` helpers from `@/stores/settings-store`, and colors SHALL use theme CSS variables (no hardcoded hex outside the documented `DRAW_COLORS` palette).

#### Scenario: Font-size change

- **WHEN** the user changes the global font size in Settings while the panel is open
- **THEN** the panel's text (URL bar, annotation list, popovers) SHALL re-render at the new size without requiring a panel close

#### Scenario: Theme change

- **WHEN** the user switches between light and dark themes
- **THEN** the panel's surface, border, and text colors SHALL update via theme variables (no flash of hardcoded color)

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

### Requirement: Test-id label overlay

When the user enables the Test-ID overlay (toolbar button, `data-testid="browser-panel-show-testids"`), the runner SHALL query `document.querySelectorAll('[data-testid]')` in the page, collect each element's bounding box + testid, and stream them to the client. The client SHALL render labeled overlays on the canvas at the corresponding positions until the overlay is disabled or the page changes.

#### Scenario: Toggle on

- **WHEN** the user clicks the Test-ID button on a page with `data-testid` elements
- **THEN** within 200 ms each tagged element SHALL have a visible label badge with its testid value drawn at its top-right corner
- **AND** the badge's color SHALL use the theme accent color

#### Scenario: Page navigation invalidates the overlay

- **WHEN** the page navigates (the URL changes inside the streamed Chrome)
- **THEN** the testid query SHALL re-run on the new page
- **AND** stale labels from the previous page SHALL disappear

### Requirement: Screenshot capture of the viewport

The toolbar SHALL include a `data-testid="browser-panel-screenshot"` button. Clicking it SHALL call `ChromeSession.screenshot()` on the runner and either (a) copy the resulting PNG to clipboard if the user holds no modifier, or (b) attach it as an inline annotation if the user clicks while annotations exist.

#### Scenario: Plain screenshot

- **WHEN** the user clicks the screenshot button with no modifier
- **THEN** the runner SHALL capture a PNG of the viewport via CDP `Page.captureScreenshot`
- **AND** the panel SHALL write the PNG to the clipboard as a `Blob`
- **AND** a toast SHALL confirm "Viewport copied to clipboard"

### Requirement: Inspect mode (hover-driven element labels)

The toolbar SHALL include an Inspect button. While Inspect mode is active, mousemove events on the canvas SHALL trigger `browser-session:inspect-at` (throttled to ~10 Hz). The client SHALL display a tooltip near the cursor with the element's tagName, testid (if any), classes, and dimensions. Inspect mode SHALL deactivate on Escape or when another tool is selected.

#### Scenario: Hover over an element

- **WHEN** Inspect is active and the user hovers at canvas coords corresponding to a `<button data-testid="signup">`
- **THEN** a tooltip SHALL appear within 100 ms showing `BUTTON.cta-primary[data-testid="signup"]`
- **AND** a colored outline SHALL highlight the element's bounding box on the canvas

### Requirement: Pause animations

The toolbar SHALL include a Pause Animations button. Clicking it SHALL call `ChromeSession.execute('document.getAnimations().forEach(a => a.pause())')`. The button is a toggle — clicking again resumes via `a.play()`.

#### Scenario: Toggle on

- **WHEN** the user clicks Pause on a page with running CSS animations
- **THEN** the next frame SHALL show the animations frozen
- **AND** the button's icon SHALL switch from ⏸ to ▶ to indicate it's paused

### Requirement: WS protocol shape

A new section in `packages/shared/src/runner-protocol.ts` SHALL define these message types and the client / runner SHALL communicate only via these:

```ts
// Client → runner
type BrowserSessionOpen   = { type: 'browser-session:open';   sessionId: string; url: string };
type BrowserSessionNav    = { type: 'browser-session:navigate'; sessionId: string; url: string };
type BrowserSessionInput  = { type: 'browser-session:input';  sessionId: string;
                              kind: 'mouseMove' | 'mouseDown' | 'mouseUp' | 'wheel' | 'keyDown' | 'keyUp';
                              ... };
type BrowserSessionInspectAt = { type: 'browser-session:inspect-at'; sessionId: string;
                                  requestId: string; x: number; y: number };
type BrowserSessionScreenshot = { type: 'browser-session:screenshot'; sessionId: string;
                                   requestId: string };
type BrowserSessionExecute = { type: 'browser-session:execute'; sessionId: string;
                                requestId: string; expression: string };
type BrowserSessionClose  = { type: 'browser-session:close'; sessionId: string };
type BrowserSessionHeartbeat = { type: 'browser-session:heartbeat'; sessionId: string };

// Runner → client
type BrowserSessionReady  = { type: 'browser-session:ready'; sessionId: string };
type BrowserSessionFrame  = { type: 'browser-session:frame'; sessionId: string; data: string };
type BrowserSessionResult = { type: 'browser-session:result'; sessionId: string;
                               requestId: string; ok: true; value: unknown }
                          | { type: 'browser-session:result'; sessionId: string;
                               requestId: string; ok: false; error: string };
type BrowserSessionConsole = { type: 'browser-session:console'; sessionId: string;
                                level: string; text: string };
type BrowserSessionError = { type: 'browser-session:error'; sessionId: string; message: string };
type BrowserSessionClosed = { type: 'browser-session:closed'; sessionId: string;
                               reason: 'user' | 'heartbeat' | 'error' | 'runner_shutdown' };
```

Every request-style message (`inspect-at`, `screenshot`, `execute`) SHALL include a `requestId`; the runner SHALL reply with a `browser-session:result` carrying the same `requestId`.

#### Scenario: Request / response round-trip

- **WHEN** the client sends `browser-session:inspect-at { sessionId, requestId: 'r1', x: 100, y: 100 }`
- **THEN** the runner SHALL reply on the same WS with `browser-session:result { sessionId, requestId: 'r1', ok: true, value: { ... } }` within 1 second
- **AND** the client SHALL match the response by `requestId` and resolve the awaiting Promise

#### Scenario: Frame stream after `ready`

- **WHEN** the runner has emitted `browser-session:ready { sessionId }`
- **THEN** it SHALL begin emitting `browser-session:frame { sessionId, data }` messages at ~30 fps (every JPEG frame from CDP `Page.screencastFrame`)
- **AND** the client SHALL render each frame onto the canvas via the `useBrowserSessionFrameRenderer` hook

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
