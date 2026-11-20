# Tasks

## 1. Setup and spikes

- [x] 1.1 Align `playwright` in `packages/runtime` and `packages/core` to the root version (≥ 1.61) and verify `bun install` succeeds and `bun run typecheck` passes
- [x] 1.2 Spike: with one headless Chromium, attach `chrome-remote-interface` screencast to a page target and `chromium.connectOverCDP` to the same browser at once; verify frames keep flowing while Playwright clicks, and correct the "single browser-level slot" comment in `core/src/chrome/chrome-session.ts` accordingly
- [x] 1.3 Spike: confirm `page.ariaSnapshot({ mode: 'ai' })` output format and `page.locator('aria-ref=<ref>')` on the pinned version; record findings in design.md D4

## 2. Browser host: one Chromium per profile, one tab per session (phase 1)

- [x] 2.1 Add `targetId` option to `ChromeSession` so it attaches to a specific page target; verify with a unit test using a mocked `CDP.List`
- [x] 2.2 Implement `BrowserHost` in `runtime/src/services/browser-automation/` (launch per user profile at `~/.funny/browser-profiles/<userId>/default` with mode `0700`, create/close tabs via `Target.createTarget`, ephemeral sessions via `Target.createBrowserContext`, exit after last tab + grace period, relaunch on crash); verify with an integration test that two tabs share cookies and an ephemeral tab does not
- [x] 2.3 Compute the regular-Chrome user agent once per binary (`HeadlessChrome/<v>` → `Chrome/<major>.0.0.0`) and pass `--user-agent`; verify a test page's `navigator.userAgent` has no `HeadlessChrome`
- [x] 2.4 Refactor `browser-session-manager.ts` onto `BrowserHost` (tab limit 8, existing panel messages unchanged, clean stale `funny-browser-*` temp dirs at startup); verify existing browser-session tests pass and the panel still opens, streams and inspects
- [x] 2.5 Add "Clear browser profile" (`browser-session:clear-profile`) that closes the user's sessions and deletes the profile dir; verify with a test that cookies are gone afterwards
- [x] 2.6 Document profile location, permissions and the clear action in `openwiki/` (operations section) and verify the doc links resolve

## 3. Thread binding, isolation and lifetime (phase 1)

- [x] 3.1 Extend the session record with `threadId`, `owner`, `profile`, `panelAttached`, `lastAgentActivity`, `controller`; add `findByThread(userId, threadId)`; verify with unit tests
- [x] 3.2 Reject any client `browser-session:*` message whose session belongs to another user; verify with a test that a foreign sessionId gets no frames/results
- [x] 3.3 Heartbeat reaping only for `owner: 'panel'`; idle sweep (15 min, Effect schedule) for thread-bound sessions; verify both paths with fake-clock tests
- [x] 3.4 Close thread sessions on thread delete/archive from the runtime thread service; verify with a test
- [x] 3.5 Add `threadId` to runner → client browser-session events and the new messages `agent-opened`, `attach`, `detach` in `shared/src/types/browser-session.ts`, the `browser.v1` schemas and `server/src/services/socketio/browser-v1-interactive.ts`; verify the protocol round-trip tests and `bun run typecheck`
  - Note: no proto/server change was needed — attach = `open` with an empty URL, detach / clear-profile = `close` reasons (free string in `browser.v1`), and `agent-opened` / `viewport` use the server's legacy per-user fallback (design D5).

## 4. Agent tools core (phase 1)

- [x] 4.1 Playwright bridge: `connectOverCDP` per host, map sessionId → `Page` by target id, follow popups to the new tab; verify with an integration test against a local fixture page
- [x] 4.2 Snapshot generations: bump on main-frame navigation, new snapshot, controller change; `stale-ref` on mismatch; size cap with truncation marker; verify with unit tests for each invalidation trigger
- [x] 4.3 Implement `browser_open`, `browser_navigate`, `browser_snapshot` (with optional screenshot image content), `browser_status`, `browser_close` returning the D12 error codes; verify with handler tests
- [x] 4.4 Implement `browser_act` (click, double_click, hover, type, fill, select, press, scroll, drag; ref or coordinates; bounded timeout → `action-timeout`); verify with fixture-page tests per action
- [x] 4.5 Implement `browser_evaluate` (await promises, JSON-serialise, truncate, `evaluate-failed`), `browser_wait_for`, `browser_resize`; verify with handler tests
- [x] 4.6 Phase-1 dialog handling: auto-dismiss and report in the next tool result; verify with a fixture page that calls `confirm()`
- [x] 4.7 Serialise panel input and agent actions per session; verify an integration test where panel input and an agent click interleave without errors

## 5. Agent wiring (phase 1)

- [x] 5.1 Build the `funny_browser` in-process SDK MCP server (threadId/userId from closure, tool calls cancelled with the spawn's AbortSignal) and inject it in `agent-startup/agent-profile.ts`, deferred loading, kill switch `FUNNY_BROWSER_TOOLS=0`; verify a test that the server is present on spawn and absent with the flag
- [x] 5.2 Ensure `mcp__funny_browser__*` is NOT covered by the `mcp__funny__*` auto-allow in `core/src/agents/sdk-claude.ts`; verify with a test in `sdk-claude-disallowed-tools.test.ts` style
- [x] 5.3 Tool instructions for the server (when to snapshot, refs expire, ask the user when a challenge appears); verify the instructions string appears in the built server
- [x] 5.4 Document the agent browser tools in `openwiki/` (agent-execution section) and verify the documented tool names match the server

## 6. Client: panel attach and tool cards (phase 1)

- [x] 6.1 `browser-panel-store`: track thread-bound sessions by threadId; on `agent-opened` for the active thread, open/badge the panel and attach; on thread switch, detach; on panel close, detach (not close) thread-bound sessions; verify with store unit tests
- [x] 6.2 `BrowserPreview`: thread label, "Close browser session" and "Clear browser profile" actions (shadcn, `data-testid`s); verify with component tests
- [x] 6.3 Browser tool cards: friendly titles in `tool-cards/mcp-tool.ts`, `BrowserToolCard` with action/target/URL/error/thumbnail and "Show in panel"; verify with unit tests in `__tests__/lib/tool-cards-utils.test.ts` and a story
  - Note: implemented inside the existing `McpToolCard` (it already renders text, errors and screenshot images); the browser-specific parts are the title, the action summary and the "Show in browser panel" button. The target is shown as the ref (`click e7`), not the element label, because the card has no snapshot. No story added.
- [x] 6.4 Verify `bun run build` for the client and `bun run lint` pass

## 7. Phase 1 integration check

- [ ] 7.1 End-to-end on a local runner: agent opens a login fixture, snapshots, fills and submits, the panel shows it live, a later turn reuses the logged-in session, and `bun run lint` + `bun run typecheck` pass
- [ ] 7.2 Manual check with the motivating case: agent opens `https://dash.cloudflare.com`, user logs in through the panel, agent then navigates and reads the account page in a later turn; record the result in the change notes

## 8. Shared control (phase 2)

- [x] 8.1 `browser-session:set-controller` message and runner enforcement (`user-has-control` for page-changing tools, read-only tools allowed, refs invalidated on change); verify with handler tests
- [x] 8.2 Panel controller indicator with "Take over" / "Hand back to agent" (shadcn, `data-testid`s); verify with component tests
- [x] 8.3 Document shared control in `openwiki/` and verify the doc matches the UI labels

## 9. Dialogs, upload, appearance (phase 2)

- [x] 9.1 Hold dialogs as `pendingDialog`, `dialog-pending` on actions, `browser_dialog` tool, panel dialog display; verify with fixture tests for alert/confirm/prompt
- [x] 9.2 `upload` action restricted to the thread's working directory via `resolveThreadCwd`; verify `path-not-allowed` for outside paths and success inside
- [x] 9.3 `browser_set_appearance` via colour-scheme emulation; verify `matchMedia('(prefers-color-scheme: dark)')` in a fixture

## 10. Recording (phase 2)

- [x] 10.1 Record screencast frames with timestamps; `browser_recording_start/stop`; encode with `ffmpeg` into thread assets; `recording-unavailable` when missing; verify with a test that stubs ffmpeg and one that checks the error path
- [x] 10.2 Show recordings in the tool card with an inline player; verify with a component test

## 11. `$BROWSER` interception (phase 2)

- [x] 11.1 `funny-open-url` shim + runner local endpoint that opens the URL in the thread session and emits `agent-opened`; set `BROWSER` in agent child env; verify a test where a child process runs `$BROWSER https://example.test` and the session navigates there
- [ ] 11.2 Manual check with `wrangler login`: confirm whether it honours `$BROWSER` and the localhost callback completes; record the result and document any CLI-specific workaround in `openwiki/`
  - Partial: verified `xdg-open` (no desktop environment) calls `$BROWSER`; `wrangler login` itself not run yet (needs a real Cloudflare login)

## 12. Phase 2 integration check

- [ ] 12.1 End-to-end: agent hits a fixture challenge, user takes over and solves it, hands back, agent continues; a confirm dialog is handled with `browser_dialog`; a recording is attached; `bun run lint` + `bun run typecheck` pass
