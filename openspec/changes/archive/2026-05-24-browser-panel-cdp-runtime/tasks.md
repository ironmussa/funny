## 1. Runner: BrowserSessionManager + Chromium spawn

- [x] 1.1 Create `packages/runtime/src/services/browser-session-manager.ts`. Export a singleton `browserSessionManager` with `open(userId, sessionId, url)`, `close(sessionId)`, `getSession(sessionId)`, plus per-session pass-through methods (`navigate`, `dispatchInput`, `inspectAt`, `inspectRect`, `screenshot`, `execute`, `heartbeat`).
- [x] 1.2 Inside the manager, each session owns: `port` (from `@funny/core/ports`), `chromeProcess: ChildProcess`, `session: ChromeSession`, `lastHeartbeat: number`, `userId`.
- [x] 1.3 Spawn Chromium using `chromium.executablePath()` from `playwright` (NOT the test runner). Args: `--remote-debugging-port=${port}`, `--headless=new`, `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage`, `--window-size=1280,720`, `about:blank`.
- [x] 1.4 Wait for CDP via `waitForChrome('localhost', port, 30_000)` then instantiate `ChromeSession` with `quality: 60, maxWidth: 1280, maxHeight: 720, format: 'jpeg'`. Call `connect()` then `navigate(url)`.
- [x] 1.5 Wire `session.on('frame', ...)` to `wsBroker.emitToUser(userId, { type: 'browser-session:frame', sessionId, data })`. Also wire `console`, `error`, and `disconnect` events to corresponding WS messages.
- [x] 1.6 Cleanup in `close(sessionId)`: `session.disconnect()`, `chromeProcess.kill('SIGTERM')` (with 2 s grace before `SIGKILL`), `freePort(port)`. Emit `browser-session:closed` with the supplied reason.
- [x] 1.7 Background heartbeat reaper: every 30 s, iterate sessions, force-close any whose `lastHeartbeat` is older than 90 s. Reason `'heartbeat'`.
- [x] 1.8 Hard cap of 4 concurrent sessions per runner. `open()` rejects with `'too-many-sessions'` past that — surfaced to the user as a toast.

## 2. Runner: HTTP + WS routes

- [x] 2.1 Add `packages/runtime/src/routes/browser-session.ts` with:
  - `POST /api/browser-session` body `{ sessionId, url }` → calls `browserSessionManager.open(...)`, returns `{ status: 'spawning' }` immediately; client waits for `browser-session:ready` on WS.
  - `DELETE /api/browser-session/:sessionId` → `browserSessionManager.close(sessionId, 'user')`.
- [x] 2.2 Mount the route under the existing user-auth middleware so each runner request is scoped to its user.
- [x] 2.3 Extend the WS message dispatcher to route `browser-session:*` client messages (`navigate`, `input`, `inspect-at`, `screenshot`, `execute`, `heartbeat`, `close`) to the matching `browserSessionManager` method. Return `browser-session:result` for request-style messages.

## 3. Shared: Protocol types

- [x] 3.1 Add the `BrowserSession*` message types from `specs/in-app-annotator/spec.md` §"WS protocol shape" to `packages/shared/src/types/browser-session.ts` (split-file convention matches existing `types/test.ts`).
- [x] 3.2 Extend the runner-protocol's master discriminated union so the existing server↔runner tunnel passes these through transparently.

## 4. Client: BrowserViewport replaces iframe with canvas

- [x] 4.1 Modify `packages/client/src/components/browser-panel/BrowserViewport.tsx`: branch on `USE_CDP` flag. CDP path renders `<BrowserSessionCanvas>` (new file); legacy keeps the iframe. Both paths kept until soak ends.
- [x] 4.2 Port the frame-renderer pattern from `BrowserPreview.tsx` into `lib/browser-session-frames.ts` — Map<sessionId, base64>, CustomEvent-driven subscription.
- [x] 4.3 `BrowserSessionCanvas` subscribes via `subscribeToFrames(sessionId, ...)`, draws JPEG onto canvas sized 1280×720.
- [x] 4.4 Browse-mode mouse / wheel handlers on the overlay forward to runner via `browserSessionClient.input(...)`, scaling canvas-relative coords → viewport 1280×720.

## 5. Client: Store changes

- [x] 5.1 Add `sessionId`, `sessionStatus`, `sessionError` + `openBrowserSession(url)` / `closeBrowserSession()` / `setSessionStatus(s, err?)`.
- [x] 5.2 Extend `Annotation` types — optional `dom` on pin (`AnnotationDomInfo`) and region (`AnnotationRegionDom` with `rect` + `elements`). Backwards-compatible.
- [x] 5.3 `togglePanel(false)` and `closePanel()` now tear down the runner session.
- [x] 5.4 Heartbeat (30s) lives in `BrowserViewport` `useEffect` keyed on `sessionId`. Clears on unmount or sessionId change.

## 6. Client: URL bar talks to runner

- [x] 6.1 `BrowserUrlBar` calls `openBrowserSession(url)` when `VITE_BROWSER_PANEL_CDP=1`; falls back to legacy `submitUrl` otherwise.
- [x] 6.2 "Spawning Chrome…" overlay shows when `sessionStatus === 'spawning'` (in BrowserViewport).
- [x] 6.3 "Browser session disconnected — Reconnect" overlay shows when `sessionStatus === 'disconnected'`. Button re-opens session at last URL.

## 7. Client: Pin tool resolves to DOM element

- [x] 7.1 PinTool now sends `browser-session:inspect-at` via `browserSessionClient.inspectAt()` after creating the visual marker. Promise-based via the request/response WS plumbing in `browser-session-client.ts`.
- [x] 7.2 Created the request-response helper inside `browser-session-client.ts` (`sendRequest`) with 5s timeout. `resolveBrowserSessionRequest` plugs in from `dispatch-browser-session-events.ts`.
- [x] 7.3 Annotation gets patched with `dom` via `updateAnnotationDom(id, dom)`. Failure path is silent (annotation remains usable without DOM data).
- [x] 7.4 Inspect helpers (`cssSelector`, `pickStyles`, `detectFrameworkComponent`, `elementInfo`) installed via `INSPECT_HELPERS` string literal in `browser-session-manager.ts`, runs once per session and after each navigate.

## 8. Client: Region tool resolves to candidate elements

- [x] 8.1 RegionTool sends `browser-session:inspect-rect` after the visual rectangle is created.
- [x] 8.2 Runner samples a 5×5 grid inside the rect, dedupes elements, computes area-of-intersection, returns top 10. Implemented in `browserSessionManager.inspectRect()`.
- [x] 8.3 `updateRegionDom(id, { rect, elements })` patches the annotation. Visual marker (dashed rectangle) is unchanged.

## 9. New toolbar buttons (the 5 grayed-out from V1 batch B)

- [x] 9.1 Show test-ids — `TestIdOverlay.tsx` polls `document.querySelectorAll('[data-testid]')` every 2s via `browser-session:execute` and renders labels over the canvas.
- [x] 9.2 Screenshot viewport — `browser-panel-screenshot` button → `browserSessionClient.screenshot()` → PNG to clipboard (with new-tab fallback if `ClipboardItem` unsupported).
- [x] 9.3 Pause animations — store toggle in `toggleAnimationsPaused` runs `getAnimations().forEach(a => a.pause()/.play())` via `browser-session:execute`.
- [x] 9.4 Inspect mode — `InspectOverlay.tsx` throttled mousemove (100ms) → `inspect-at` → tooltip with selector / testid / component / dimensions + highlight rectangle. Escape exits.

## 10. SendDialog enriches markdown + image attachments

- [x] 10.1 `annotationsToMarkdown` adds per-pin "### Element" subsection and per-region "### Candidate elements" list with `selector` / `testid` / `componentName` / `text`.
- [ ] 10.2 _Deferred to follow-up:_ per-element screenshots from `inspect-at`. Current `extractImageAttachments` still pulls only the draw canvas. Annotations have enough data without — the agent can navigate via selector.
- [x] 10.3 18/18 markdown unit tests pass, including 3 new cases: pin with dom, region with elements, legacy-pin-without-dom backwards compatibility.

## 11. Feature flag + fallback

- [x] 11.1 `VITE_BROWSER_PANEL_CDP=1` enables CDP path in `BrowserViewport.tsx`, `BrowserUrlBar.tsx`, `PinTool.tsx`, `RegionTool.tsx`, `ToolToolbar.tsx`. Unset/`'0'` keeps legacy iframe.
- [x] 11.2 BrowserViewport renders the appropriate branch per the flag.
- [ ] 11.3 _Deferred to follow-up:_ document the flag in the repo README. The flag is documented in `proposal.md` and the openspec change folder is enough until soak begins.

## 12. Telemetry

- [x] 12.1 `browser_session.opened` and `browser_session.closed` (attr `reason`) emitted from `BrowserSessionManager`; `browser_session.inspect` span wraps `inspectAt` / `inspectRect`. Frame-dropped counter deferred — wsBroker already emits `ws.events sent=0` when no clients are attached.
- [x] 12.2 `createClientLogger('browser-session')` used across new client modules; runtime uses `log` with `namespace: 'browser-session'`. The standard `__funnyLog.setNamespaceLevel('browser-session', 'debug')` toggle works because it operates on the namespace string.

## 13. Tests

- [ ] 13.1 _Deferred to follow-up:_ `browser-session-frames.test.ts` — the scaling math + subscription pattern is exercised indirectly by component tests; a focused unit needs a JSDOM mock of `<canvas>` which is non-trivial to set up.
- [ ] 13.2 _Deferred to follow-up:_ runner integration test for `inspectAt`. Spawning real Chromium in CI requires the binary + `--no-sandbox` permission and is a separate infra change.
- [ ] 13.3 _Deferred to follow-up:_ `e2e/browser-panel-cdp.spec.ts` for the flag-on flow. Same blocker as 13.2.
- [x] 13.4 18 markdown tests + the existing 897 client unit tests + V1 E2E specs all green (legacy flag-off path unchanged).

## 14. Verification + rollout

- [x] 14.1 `bunx tsc --noEmit` clean (entire repo, including runtime + client + shared).
- [x] 14.2 `bun run build` succeeds.
- [x] 14.3 Manual verification with flag on against any public URL — confirmed by user.
- [x] 14.4 Manual verification of Pin → element selector capture — confirmed by user.
- [x] 14.5 Manual verification of test-ids / screenshot / pause / inspect — confirmed by user.
- [x] 14.6 `git diff packages/chrome-extension` is empty.
- [ ] 14.7 _Tracked separately:_ 14-day soak before removing the legacy iframe path. Done in a follow-up cleanup change (not blocking this archive).
