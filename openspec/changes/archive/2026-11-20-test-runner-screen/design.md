## Context

The funny UI currently has no way to run or monitor Playwright e2e tests. Developers must switch to a terminal, run tests manually, and have no visual feedback of the headless browser. The project already has a `packages/podman-chrome-streaming/` package with a `ChromeSession` class that streams headless Chrome frames via CDP `Page.startScreencast` — this is the foundation for live browser streaming.

The right-side pane currently only contains the `ReviewPane` (git diff viewer). It needs to be extended with a tab system to host both Review and the new Test Runner views.

### Current state

- Right pane: Single `ReviewPane`, toggled via `reviewPaneOpen` in `ui-store.ts`, rendered in `App.tsx`
- WebSocket events: Typed union `WSEvent` in `packages/shared/src/types.ts`, dispatched via `ws-broker.ts`
- Chrome streaming: `ChromeSession` class in `packages/podman-chrome-streaming/src/chrome-session.ts` handles CDP connection, screencast frame relay, and frame acknowledgment
- Test files: Playwright specs in `e2e/*.spec.ts`, configured in `playwright.config.ts`

## Goals / Non-Goals

**Goals:**

- Let users discover, run, and visually monitor Playwright tests from within the funny UI
- Stream live headless Chrome video during test execution using existing CDP infrastructure
- Show real-time test output (stdout/stderr) alongside the browser stream
- Support per-file and bulk test execution with clear status indicators
- Add a tab system to the right pane to switch between Review and Tests

**Non-Goals:**

- Interactive browser control (click/type into the streamed browser) — watch-only
- Unit test support (Vitest) — this is Playwright e2e tests only
- Test result persistence in the database — results are ephemeral (in-memory for the session)
- Multi-project test aggregation — tests are scoped to the currently selected project
- Parallel test execution — one test run at a time per project
- Test editing or creation from the UI

## Decisions

### 1. Right pane tab system

**Decision:** Add a `rightPaneTab: 'review' | 'tests'` field to `ui-store.ts`. The right pane container in `App.tsx` renders either `ReviewPane` or `TestRunnerPane` based on the active tab. Tab switching buttons appear at the top of the right pane.

**Alternative considered:** Separate toggle booleans (`reviewPaneOpen`, `testPaneOpen`). Rejected because only one right pane should be visible at a time, and a single discriminated field is simpler.

### 2. Test discovery via filesystem glob

**Decision:** Server endpoint `GET /api/tests/:projectId/files` uses `glob` to find `**/*.spec.ts` files relative to the project root. Returns a flat list of relative paths. The client builds the tree structure.

**Alternative considered:** Server-side tree building. Rejected because the client already has tree-building patterns in ReviewPane and the file count is small (typically <50 files).

### 3. Chrome streaming via CDP screencast (reuse ChromeSession)

**Decision:** Import `ChromeSession` and `waitForChrome` from `packages/podman-chrome-streaming/`. When a test starts, spawn Playwright with `--headed` and a fixed remote debugging port (`--remote-debugging-port=9223`). Connect `ChromeSession` to that port, start screencast, and relay frames via `ws-broker` as `test:frame` events.

**Alternative considered:** VNC/noVNC streaming. Rejected because CDP screencast is already implemented in the codebase, is lighter weight, and doesn't require additional infrastructure.

**Alternative considered:** Taking periodic screenshots instead of screencast. Rejected because it would be much lower fidelity and the screencast approach gives near-real-time video.

### 4. Test process spawning

**Decision:** Use `execa` (consistent with `git-v2.ts` patterns) to spawn `npx playwright test <file> --headed --reporter=line` with the environment variable `PLAYWRIGHT_CHROMIUM_DEBUG_PORT=9223`. Parse stdout/stderr line-by-line and emit `test:output` WS events. Track the child process for stop/kill support.

**Why `--reporter=line`:** Produces clean, parseable single-line output per test result (pass/fail/skip with test name).

### 5. WebSocket frame delivery

**Decision:** Send CDP screencast frames as `test:frame` WS events through the existing `ws-broker`. Each frame carries base64 JPEG data. The client renders frames onto a `<canvas>` element via `drawImage()` with an `Image` object.

**Trade-off:** Frames are base64-encoded (33% overhead). Binary WebSocket frames would be more efficient but would require changes to the ws-broker which currently only handles JSON. The overhead is acceptable for a debugging/monitoring tool at 720p quality.

### 6. Client-side canvas rendering

**Decision:** The `BrowserPreview` component maintains a `<canvas>` ref. On each `test:frame` event, it creates an `Image`, sets `src` to a data URI from the base64 JPEG, and draws it on the canvas on `onload`. This is the same approach used in `packages/podman-chrome-streaming/src/viewer.html`.

### 7. One test run at a time

**Decision:** The server allows only one active test run per project. Starting a new test while one is running returns a 409 Conflict. The client shows a stop button during execution.

## Risks / Trade-offs

- **[CDP port collision]** → Use a high port (9223) and make it configurable. Only one test runs at a time per project, so port reuse is safe.
- **[Playwright not installed]** → The test discovery endpoint returns an empty list if no `e2e/` directory exists. The run endpoint returns a clear error if Playwright is not installed.
- **[Frame bandwidth]** → CDP screencast JPEG frames at 720p ~60-80KB each at quality 60. At ~10fps this is ~600-800KB/s. Acceptable for local/LAN use. Quality and maxWidth are configurable in ChromeSession.
- **[Browser window not available]** → Playwright may not produce a visible browser window in all environments (CI, headless-only). The UI gracefully shows "No video stream" if no frames arrive within a timeout.
- **[Chrome startup delay]** → `waitForChrome()` polls until the debug port is ready (up to 30s). The client shows a "Connecting to browser..." state during this window.
