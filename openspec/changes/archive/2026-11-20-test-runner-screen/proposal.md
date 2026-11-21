## Why

There is no way to run and visually monitor Playwright e2e tests from within the funny UI. Developers must switch to a terminal, run tests manually, and have no visual feedback of what the headless browser is doing. A built-in test runner with live browser streaming would let users discover, run, and watch Playwright tests execute — all without leaving the app.

## What Changes

- Add a **tab system** to the right-side pane so it can switch between "Review" (existing ReviewPane) and "Tests" (new TestRunnerPane)
- Add a **Test File Browser** that discovers and lists all `.spec.ts` files from the active project's `e2e/` directory, with search/filter, folder grouping, and per-file play buttons
- Add a **Browser Preview** panel that streams live video from headless Chrome via CDP `Page.startScreencast`, reusing the existing `packages/podman-chrome-streaming/` package
- Add a **Test Output Log** that streams Playwright stdout/stderr in real-time below the browser preview
- Add **server-side test runner service** with API routes to discover test files, run tests, and stop running tests
- Add **WebSocket events** for test frames (`test:frame`), output lines (`test:output`), and status changes (`test:status`)
- Add **client-side Zustand store** (`test-store.ts`) for test file list, running state, and per-file results

## Capabilities

### New Capabilities

- `test-file-discovery`: Server-side discovery of Playwright `.spec.ts` files for a project, exposed via REST API
- `test-execution`: Server-side spawning and management of Playwright test processes with CDP connection for browser streaming
- `test-runner-ui`: Client-side test runner pane with file browser, browser video stream, and test output log
- `right-pane-tabs`: Tab system for the right-side pane to switch between Review and Tests views

### Modified Capabilities

<!-- No existing specs to modify -->

## Impact

- **Client:** New components (`TestRunnerPane`, `TestFileBrowser`, `BrowserPreview`), new store (`test-store.ts`), modified `App.tsx` and `ui-store.ts` for tab switching
- **Server:** New routes (`routes/tests.ts`), new service (`services/test-runner.ts`), new WebSocket event types
- **Shared:** New TypeScript types for test-related WebSocket events and API request/response shapes
- **Dependencies:** Reuses `ChromeSession` from `packages/podman-chrome-streaming/` — may need to export it or make it importable from the server package
- **Infrastructure:** Requires Playwright and a Chromium browser installed on the machine running the server
