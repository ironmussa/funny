## 1. Shared Types

- [x] 1.1 Add test-related WebSocket event types to `packages/shared/src/types.ts`: `test:frame`, `test:output`, `test:status` with their data interfaces (`WSTestFrameData`, `WSTestOutputData`, `WSTestStatusData`)
- [x] 1.2 Add test-related API types to shared: `TestFile` interface, `RunTestRequest`, `RunTestResponse`
- [x] 1.3 Add the new event types to the `WSEvent` union

## 2. Server — Test File Discovery

- [x] 2.1 Create `packages/runtime/src/services/test-runner.ts` with a `discoverTestFiles(projectPath: string)` function that globs for `**/*.spec.ts` and returns relative paths
- [x] 2.2 Create `packages/runtime/src/routes/tests.ts` with `GET /api/tests/:projectId/files` endpoint that calls `discoverTestFiles` and returns the file list
- [x] 2.3 Mount the test routes in `packages/runtime/src/index.ts`

## 3. Server — Test Execution & CDP Streaming

- [x] 3.1 Add `runTest(projectPath, file, userId)` to `test-runner.ts`: spawn Playwright with `--headed --reporter=line` and `PLAYWRIGHT_CHROMIUM_DEBUG_PORT=9223`, pipe stdout/stderr as `test:output` WS events via `ws-broker`
- [x] 3.2 Add CDP connection logic: after process spawn, call `waitForChrome(localhost, 9223)` then create `ChromeSession`, start screencast, and relay frames as `test:frame` WS events
- [x] 3.3 Add lifecycle status events: emit `test:status` with `running` on start, `passed`/`failed` on exit, handle cleanup (disconnect ChromeSession, clear active run)
- [x] 3.4 Add `stopTest(projectId)` function: kill the child process, disconnect ChromeSession, emit `test:status` with `stopped`
- [x] 3.5 Add `POST /api/tests/:projectId/run` and `POST /api/tests/:projectId/stop` endpoints in `routes/tests.ts`
- [x] 3.6 Enforce one-test-at-a-time per project: return 409 if a test is already running

## 4. Client — UI Store & State

- [x] 4.1 Add `rightPaneTab: 'review' | 'tests'` field and `setRightPaneTab` action to `packages/client/src/stores/ui-store.ts`
- [x] 4.2 Create `packages/client/src/stores/test-store.ts` Zustand store with: `files` (list), `isRunning`, `activeRunId`, `activeFile`, `fileStatuses` (map of file → idle/running/passed/failed), `outputLines` (array), `isStreaming` (frames arriving), actions for `setFiles`, `startRun`, `updateStatus`, `addOutputLine`, `reset`

## 5. Client — Right Pane Tab System

- [x] 5.1 Modify `App.tsx` right pane section: add tab bar at the top with "Review" and "Tests" tabs, conditionally render `ReviewPane` or `TestRunnerPane` based on `rightPaneTab`
- [x] 5.2 Ensure existing ReviewPane toggle (`reviewPaneOpen`) still controls pane visibility regardless of active tab

## 6. Client — Test Runner Components

- [x] 6.1 Create `packages/client/src/components/TestRunnerPane.tsx` — main container with vertical split: TestFileBrowser (top) and BrowserPreview + output log (bottom)
- [x] 6.2 Create `packages/client/src/components/test-runner/TestFileBrowser.tsx` — search input, virtualized file tree with folder grouping/chevrons, play button per file, status dots, "Run All" button in toolbar
- [x] 6.3 Create `packages/client/src/components/test-runner/BrowserPreview.tsx` — `<canvas>` element for rendering screencast frames, placeholder states ("No test running", "Connecting to browser...")
- [x] 6.4 Create test output log section in BrowserPreview: scrollable div showing `test:output` lines, auto-scroll behavior, stderr in red
- [x] 6.5 Add stop button to TestRunnerPane toolbar that calls `/api/tests/:projectId/stop`

## 7. Client — WebSocket Event Handling

- [x] 7.1 Add handlers in `hooks/use-ws.ts` (or test-store) for `test:frame`, `test:output`, and `test:status` events to update the test store
- [x] 7.2 Wire `test:frame` events to canvas rendering in `BrowserPreview` (create Image from base64, drawImage on canvas)
- [x] 7.3 Wire `test:status` events to update `fileStatuses` map and `isRunning` state

## 8. Integration & Polish

- [ ] 8.1 Add `data-testid` attributes to all interactive elements (tab buttons, play buttons, stop button, search input, run-all button)
- [ ] 8.2 Add translation keys for test runner UI strings to `en/translation.json`, `es/translation.json`, `pt/translation.json`
- [ ] 8.3 Verify the build compiles without errors: `bun run build`
