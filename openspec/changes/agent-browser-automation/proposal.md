# Proposal

## Why

Agents in Funny cannot operate a web UI on the user's behalf. When a task needs a browser — logging into the Cloudflare dashboard, finishing `wrangler login`, checking a deployed page — the agent either spawns a separate browser it cannot show the user (the `@playwright/mcp` preset launches its own Chromium) or tries to open the system browser, which on a headless runner hangs the turn. Funny already runs a real Chromium per panel session on the runner and streams it to the Browser Panel over CDP; what is missing is a way for the agent to drive that same session, with the user watching and able to step in.

## What Changes

- **Agent browser tools.** A new in-process MCP server on the runner exposes browser tools to the agent, bound to the spawn's thread and user: `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_act`, `browser_evaluate`, `browser_wait_for`, `browser_status`, `browser_resize`, `browser_close` (phase 1) and `browser_dialog`, `browser_set_appearance`, `browser_recording_start`, `browser_recording_stop` (phase 2).
- **Same browser for agent and user.** The agent's tools drive the Chromium that the Browser Panel already streams. When the agent opens a page, the panel attaches to that thread's session so the user sees every action live.
- **Accessibility snapshot with element references.** `browser_snapshot` returns the page's accessibility tree with short element references; `browser_act` targets elements by reference (or by coordinates). References expire on navigation, on a newer snapshot, and on a change of control.
- **Thread-bound sessions.** A browser session can belong to a thread. Agent-owned sessions survive panel close and agent turns, and are reaped by idle timeout or thread deletion instead of the panel heartbeat.
- **Persistent per-user profile.** Sessions use a persistent Chromium profile on the runner by default, so logins (e.g. Cloudflare) survive across sessions. An ephemeral (incognito-like) session remains available.
- **Regular browser identity.** The headless browser reports a normal `Chrome/<version>` user agent instead of `HeadlessChrome/<version>`.
- **Phase 2: shared control.** An explicit controller (agent or user) with take-over / hand-back in the panel; dialogs (accept/dismiss/prompt), file upload, light/dark appearance, viewport recording, and opening URLs launched by the agent's child processes (`$BROWSER`) in the thread's session.
- **Tool cards.** The thread view renders browser tool calls as readable cards (action, target, URL, screenshot thumbnail, "show in panel").
- **BREAKING (internal):** the runner moves from one Chromium process per panel session to one Chromium per user profile with one tab per session. The client ↔ runner `browser-session:*` messages gain a `threadId`; existing panel behaviour is preserved.

## Capabilities

### New Capabilities

- `agent-browser-automation`: agent-facing browser tools over the runner's browser sessions — tool set, session ↔ thread ↔ user binding, accessibility snapshot and element references, action semantics and errors, shared control between agent and user, dialogs, recording, external-URL interception, and tool cards.

### Modified Capabilities

- `in-app-annotator`: the browser session lifecycle no longer binds only to panel open/close (thread-bound sessions outlive the panel); sessions gain a persistent per-user profile and a regular-Chrome user agent; the panel attaches to a thread's agent-opened session.

## Impact

- **Runtime:** `services/browser-session-manager.ts` (process-per-profile, tab-per-session, thread binding, idle reaping), new `services/browser-automation/` (Playwright connection, snapshot/refs, actions, controller), new in-process MCP server wired through `agent-startup/agent-profile.ts` / `agent-tooling.ts`, `app/browser-session-message-handler.ts`.
- **Core:** `chrome/chrome-session.ts` attaches to a specific page target instead of "the first page".
- **Shared:** `types/browser-session.ts` and the `browser.v1` browser-session schemas (`threadId`, controller events, agent-opened events).
- **Server:** `services/socketio/browser-v1-interactive.ts` forwards the new fields/events; no new runner routes (agent tools run in-process on the runner).
- **Client:** `stores/browser-panel-store.ts`, `components/test-runner/BrowserPreview.tsx` (attach to thread session, controller UI), `components/tool-cards/mcp-tool.ts` + new browser tool cards.
- **Dependencies:** `playwright` in `runtime`/`core` aligned to the root version (≥ 1.61) for `ariaSnapshot` AI mode and `aria-ref` locators; optional `ffmpeg` on the runner for recording (phase 2).
- **Data on disk:** `~/.funny/browser-profiles/<userId>/` on the runner holds cookies and site data (mode `0700`).
