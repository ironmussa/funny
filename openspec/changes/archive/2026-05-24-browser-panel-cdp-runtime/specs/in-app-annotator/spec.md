## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Browser session lifecycle binds to panel open/close

The Browser Panel SHALL maintain at most one active browser session per panel-open. Opening the panel and submitting a URL SHALL open a session; closing the panel (via the toggle, the close button, or unmount) SHALL close the session. If the user submits a different URL while the panel is open, the session is reused via `Page.navigate`.

#### Scenario: Panel closes → session closes

- **WHEN** the user clicks the globe icon while the panel is open with a live session
- **THEN** the client SHALL send `browser-session:close { sessionId }` to the runner
- **AND** the runner SHALL call `ChromeSession.disconnect()` and `chromeProcess.kill()`
- **AND** a `browser_session.closed` counter SHALL be recorded with `reason: 'user'`

#### Scenario: Heartbeat lost → session reaped

- **WHEN** the runner has not received a heartbeat from the client for 90 seconds
- **THEN** the runner SHALL force-close the session
- **AND** `browser_session.closed` SHALL be recorded with `reason: 'heartbeat'`

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
