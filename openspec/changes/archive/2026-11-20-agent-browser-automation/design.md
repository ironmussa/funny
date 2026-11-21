# Design

## Context

See proposal.md — Why. Current state on the runner:

- `browser-session-manager.ts` spawns **one headless Chromium process per panel session** (`--remote-debugging-port`, `--headless=new`, `--user-data-dir=<mkdtemp>`), max 4 per runner, reaped after 90 s without a panel heartbeat. Sessions carry `userId` but no thread (events go out with `threadId: ''`).
- `@funny/core/chrome` `ChromeSession` uses `chrome-remote-interface` against **the first page target** for screencast, input, inspect, execute, history and screenshots.
- Funny's own agent tools (`funny_watch`, `funny_spawn`, …) are an **in-process SDK MCP server** built per spawn in `agent-startup/agent-profile.ts` (`withWatchMcpServer`), so handlers get `threadId`/`userId` from the closure and never from the model. `mcp__funny__*` is auto-allowed in `sdk-claude`.
- `playwright` is already a runtime dependency (only used to locate the Chromium binary) and `core/agents/llm/browser-tools.ts` has a separate, self-launching Playwright toolset for the E2E agent.
- The runner is per user; the server proxies panel traffic through `socketio/browser-v1-interactive.ts`.

No Electron exists or is needed: the panel's screencast is the "visible browser".

## Goals / Non-Goals

**Goals:**

- Agent and user drive one Chromium tab per thread; the user watches every agent action in the panel.
- Element-reference based automation that is robust to page churn (refs expire explicitly).
- Logins persist on the runner so the agent can operate authenticated dashboards.
- Keep all automation on the runner, with no new server → runner request routes and no change to runner isolation.

**Non-Goals:**

- Electron or any native browser window.
- Anti-bot evasion beyond normalising the `HeadlessChrome` user-agent token (no fingerprint spoofing, no CAPTCHA solving — the user takes over).
- Browser tools for non-Claude providers (Codex, Gemini ACP) in this change; the runtime design keeps them reachable later (see Open Questions).
- Replacing the E2E agent's `browser-tools.ts` or removing the `@playwright/mcp` preset.
- Multiple tabs per thread exposed to the agent (popups are followed, see D7).

## Decisions

### D1. Tools run in-process on the runner, in a separate `funny_browser` MCP server

Built per spawn next to the `funny` server in `agent-profile.ts`, with `threadId`/`userId` captured in the closure. Tool names: `mcp__funny_browser__browser_*`.

- _Why a separate server:_ `mcp__funny__*` is auto-allowed; browser actions must go through the thread's permission mode (spec: "Browser tools follow the thread's permission mode"). A separate server name also lets the tools be deferred (not `alwaysLoad`) so 13 schemas don't sit in every prompt.
- _Alternative:_ an HTTP/stdio MCP server process per runner — needed only for non-Claude providers; adds an auth hop. Rejected for phase 1.

### D2. One Chromium process per user profile; one tab (page target) per session

Replace process-per-session with a `BrowserHost` per user: a single Chromium with `--user-data-dir=~/.funny/browser-profiles/<userId>/default` (dir `0700`). A session is a tab created through Playwright — `browser.contexts()[0].newPage()` for persistent sessions, `browser.newContext({ viewport: null })` + `newPage()` for ephemeral ones (incognito-like, disposed on close). _Spike finding:_ raw `Target.createBrowserContext` over a second CDP client returns "Not allowed" once Playwright is attached, so Playwright owns tab creation and the panel attaches by target id (`Target.getTargetInfo`).

- _Why:_ Chromium locks a `user-data-dir` to one process, so a persistent profile cannot be shared by several processes. Tabs in one process share cookies, which is exactly the "logins persist" behaviour.
- _Alternative:_ keep one process per session and copy the profile in/out — racy, loses concurrent writes. Rejected.
- `MAX_SESSIONS` becomes a tab limit per runner (raise to 8); the host process exits when its last tab closes and after a short grace period.
- If the host process dies, all its sessions close with reason `error` and the next open relaunches it.

### D3. Two CDP clients on the same tab: `chrome-remote-interface` for the panel, Playwright for the agent

`ChromeSession` gains a `targetId` option and attaches to that page target (instead of "first page"). The agent side calls `chromium.connectOverCDP('http://127.0.0.1:<port>')` once per host and maps sessionId → Playwright `Page` by target id (via `page.context().newCDPSession(page)` + `Target.getTargetInfo`).

- _Why:_ the panel pipeline (screencast, input, inspect, annotator features) works today and stays untouched; Playwright brings auto-waiting actions, `ariaSnapshot`, `aria-ref` locators, dialogs, file chooser and video for free.
- Chrome accepts multiple CDP clients per target and per browser (_spike verified:_ screencast frames keep flowing while Playwright clicks and fills on the same tab; `browser.close()` on a `connectOverCDP` browser only disconnects). The old comment in `chrome-session.ts` about a single browser-level slot was corrected.
- Viewport emulation stays with the panel's CDP client (`Emulation.setDeviceMetricsOverride`); Playwright tabs use `viewport: null` so the two clients never fight over it. `browser_resize` goes through the panel client and emits `browser-session:viewport` so the panel rescales input.
- _Alternative:_ migrate the panel to Playwright `CDPSession` too (one client). Cleaner long-term, more churn now; deferred.
- Align `playwright` in `runtime`/`core` to the root version (≥ 1.61) for `ariaSnapshot({ mode: 'ai' })` and the `aria-ref=` selector.

### D4. Snapshot generations and reference expiry

The automation layer keeps `generation` per session. `browser_snapshot` increments it and calls `page.ariaSnapshot({ mode: 'ai' })`; references in the output are recorded as `{ref, generation}`. A reference is valid only if its generation equals the current one. The generation is bumped (invalidating refs) on main-frame `framenavigated`, on each new snapshot, and on controller change. `browser_act` resolves refs with `page.locator('aria-ref=<ref>')` after the generation check; any mismatch → `stale-ref`.

_Spike finding:_ Playwright keeps old `aria-ref` ids resolvable across snapshots and reuses ids, so expiry cannot rely on Playwright — the generation check is ours.

Snapshot output is capped (e.g. 40 k chars) with a `[truncated — use browser_evaluate or scroll]` marker. Screenshots are JPEG viewport images returned as MCP image content.

### D5. Session ↔ thread binding and lifetime

Session record gains `threadId | null`, `owner: 'panel' | 'thread'`, `profile`, `panelAttached`, `lastAgentActivity`, `controller`. Rules (spec: "Agent-owned session lifetime"):

- `browser_open` looks up the session by (userId, threadId); creates a thread-bound one if missing.
- Panel heartbeat reaping applies only to `owner: 'panel'`; thread-bound sessions are reaped by an idle sweep (15 min without agent calls and without panel attached).
- Thread delete/archive in the runtime's thread service calls `closeForThread(threadId)`.
- Every `browser-session:*` message from the client is checked against `session.userId` (fixes the current gap where any sessionId is accepted).
- Thread-bound sessions use the deterministic id `thread:<threadId>` (`threadBrowserSessionId` in shared), so the panel attaches without a lookup. Attach = `browser-session:open` with an empty URL (re-attaches, never creates; replies `closed { reason: 'not_found' }` when missing). Detach = `browser-session:close { reason: 'detach' }`. Clear profile = `close { reason: 'clear-profile' }`. Reusing existing messages avoids `browser.v1` proto changes (the close reason is already a free string).
- Runner → client events carry `threadId` inside `data` (the envelope keeps `threadId: ''` so user-scoped routing is unchanged). New `browser-session:agent-opened` and `browser-session:viewport` events have no `browser.v1` payload; the server's publication falls back to the legacy per-user event for them.

### D6. Controller (phase 2)

`controller` defaults to `agent` for thread-bound sessions. Panel "Take over" sends `browser-session:set-controller { controller: 'user' }`; while `user`, the panel forwards input and agent page-changing tools return `user-has-control`. Read-only tools still work so the agent can poll with `browser_wait_for` / `browser_status`. In phase 1 there is no lock: user input is always forwarded, and any user navigation invalidates refs through D4.

### D7. Dialogs, popups, uploads

- Phase 1: a `page.on('dialog')` handler dismisses and records the dialog; the next tool result includes `dialog: { type, message, dismissed: true }`.
- Phase 2: dialogs are held as `pendingDialog`; actions return `dialog-pending` until `browser_dialog`.
- Popups (`window.open`, `target=_blank`): the session switches to the new tab (and the panel follows), keeping one active tab per thread; the opener stays open in the background and is closed with the session.
- Uploads (phase 2) use Playwright `setInputFiles` after resolving paths with `resolveThreadCwd(thread, project)` and rejecting anything outside.

### D8. User agent

At host launch, read `Browser.getVersion().userAgent`, replace `HeadlessChrome/<v>` with `Chrome/<major>.0.0.0`, and relaunch flags include `--user-agent=<value>` (computed once per Chromium binary and cached). A flag covers workers and all tabs, unlike per-page overrides.

### D9. Recording (phase 2)

Record from the existing screencast frames (already flowing for the panel) into a temp dir with timestamps; on stop, encode with `ffmpeg` (variable frame rate → WebM/MP4) into the thread's assets and return the path. No `ffmpeg` → `recording-unavailable`. Avoids Playwright's `recordVideo`, which only works for contexts it creates.

### D10. `$BROWSER` shim (phase 2)

Agent child processes get `BROWSER=<runtime>/bin/funny-open-url` with env `FUNNY_THREAD_ID`/`FUNNY_RUNNER_SOCKET`. The shim posts the URL to the runner's local control endpoint, which opens it in the thread session (D5) and emits `agent-opened`. The Chromium runs on the runner host, so `localhost` OAuth callbacks reach the CLI.

### D11. Tool cards

Extend the friendly-title mapping in `components/tool-cards/mcp-tool.ts` for `mcp__funny_browser__*` and add a `BrowserToolCard` (action + target label from the snapshot line, URL, thumbnail, "Show in panel" → open panel attached to the thread session).

### D12. Error contract

All tools return `{ ok: true, ... }` or an MCP error whose text starts with a stable code: `no-browser-session`, `stale-ref`, `action-timeout`, `evaluate-failed`, `too-many-sessions`, `user-has-control`, `dialog-pending`, `path-not-allowed`, `recording-unavailable`, `browser-unavailable` (no Chromium binary). Messages tell the agent the next step (e.g. "take a new snapshot").

Async orchestration (host launch, idle sweep, timeouts, tool-call cancellation tied to the spawn's AbortSignal) uses Effect per `AGENTS.md`; service methods return `ResultAsync`.

## Risks / Trade-offs

- [Cookies on runner disk; the agent can read non-HttpOnly cookies via `browser_evaluate`] → profile dir `0700` under the runner user; tools gated by the thread's permission mode (D1); "Clear profile" action; ephemeral profile option. Runners are already a trust boundary (see INSTALL.md).
- [Agent performs destructive actions in an authenticated dashboard] → user sees it live; permission mode applies; phase 2 take-over.
- [Sites still challenge headless Chrome even with UA fix (e.g. Cloudflare Turnstile)] → user solves it via the panel (Browse mode in phase 1, take-over in phase 2); no evasion work.
- [Two CDP clients on one tab interfere (e.g. both enabling screencast, input state)] → Playwright never starts screencast; panel input and agent actions are serialised per session; verified by an integration test.
- [Process-per-profile means one crash closes all of a user's sessions] → auto-relaunch on next open; sessions report `error` so the agent can reopen.
- [Large snapshots blow the context] → size cap + truncation marker; agent can scope with `browser_evaluate`.
- [`ariaSnapshot` AI mode / `aria-ref` API shape differs between Playwright versions] → pin the version; contract test on a fixture page.

## Migration Plan

1. Land D2/D3 behind the existing panel protocol (no visible change), then thread binding (D5) and agent tools (D1, D4, D8) — phase 1.
2. Existing temp-profile sessions simply stop being created; no data migration. Old `funny-browser-*` temp dirs are cleaned on runner start.
3. Server and runner deploy together (new `browser-session:*` fields are optional; an old client ignores `agent-opened`).
4. Rollback: disable the `funny_browser` server injection with a runtime flag (`FUNNY_BROWSER_TOOLS=0`); the panel keeps working on the new host.

## Open Questions

- Non-Claude providers: expose the same tools through a local HTTP MCP endpoint on the runner authenticated per spawn — deferrable, does not change the runtime services.
- Recording output format (WebM vs MP4) and retention in thread assets.
- Exact idle timeout and tab limit values (start with 15 min / 8 tabs, tune from metrics).
