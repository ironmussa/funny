# Agent browser (shared browser sessions)

Agents can drive a real Chromium on the user's runner — the same browser the user watches in the Browser Panel. Use it for web tasks such as dashboards, OAuth logins or checking a deployed page, instead of a system browser or a separately launched one. Spec: `openspec/changes/agent-browser-automation/`.

## Session model

- **One Chromium per user, one tab per session.** `packages/runtime/src/services/browser-automation/browser-host.ts` launches headless Chromium on a persistent profile and connects Playwright (`connectOverCDP`). Each session is a tab. The panel's `ChromeSession` (`@funny/core/chrome`) attaches to the same tab by CDP target id for screencast and input, while the agent drives it through Playwright. Panel input and agent actions are serialised per tab.
- **Panel-owned sessions** (random id) close with the panel or after a 90 s heartbeat loss.
- **Thread-bound sessions** (id `thread:<threadId>`, see `threadBrowserSessionId` in `@funny/shared`) are shared between a thread's agent and the panel. Closing the panel only detaches. They close on `browser_close`, "Close browser session" in the panel, 15 min with no agent call and no panel, thread delete/archive, or runner shutdown.
- **Isolation.** Every panel message is checked against the session's owner, and agent tools only reach their own thread's session (`threadId` / `userId` come from the spawn, never from the model).
- **Identity.** Chromium reports `Chrome/<major>.0.0.0` instead of `HeadlessChrome/…` (`user-agent.ts`). This is identity normalisation only: CAPTCHAs and two-factor prompts are solved by the user in the panel.

## Transport: runner → browser

Browser-session events (`frame`, `ready`, `closed`, `agent-opened`, `controller`, `dialog`, …) are addressed to the **user**, not to a thread: the envelope has `threadId: ''` and a thread session carries its thread in `data.threadId`. Over `runner.v2` they travel as `EventsRequest.user_event` (`protocol/runner/v2/events.proto`). These events are transient, so they have no scope or sequence, are never persisted or replayed, and get no receipt.

- The runner sends them only when the server enabled `RUNNER_CAPABILITY_USER_EVENTS` in its hello (`RunnerEventPublisher`).
- The server relays them only to the runner owner (`events-handler.ts`). A `data.threadId` must pass the same thread authorization as agent events; it is cached per stream for 60 s.
- `isRunnerUserEventType` (`@funny/shared/runner-protocol`) is the allow-list on both ends; only `browser-session:*` is allowed today.

Without this path, the runner drops every event that has no thread.

## Profile on disk

- Location: `<FUNNY_DATA_DIR or ~/.funny>/browser-profiles/<userId>/default` on the runner, mode `0700`. It holds cookies, local storage and logins, so sites stay signed in across sessions and runner restarts.
- `browser_open { profile: 'ephemeral' }` opens an isolated, incognito-like context instead. It is discarded on close.
- **Clear browser profile** (panel `…` menu → _Clear browser profile…_) closes every session of the user, stops Chromium and deletes the profile directory. The client sends `browser-session:close { reason: 'clear-profile' }`.

## Agent tools (`funny_browser` MCP server)

The browser does not depend on the agent. The tools are defined once (`browserToolDefinitions` in `browser-mcp-server.ts`) and served to every agent alike (Claude, Codex, ACP providers) over streamable HTTP (`services/agent-mcp-http.ts`, shared with the `funny` server; path `/mcp/funny_browser`). `withBrowserMcpServer` (`agent-startup/agent-profile.ts`) injects the entry `{ type: 'http', url, headers }`.

- The listener binds to `127.0.0.1` on an ephemeral port and is separate from the runtime API, so the server tunnel cannot reach it.
- Each thread gets one random bearer token, bound to its user and paths, that opens both of Funny's servers. The token is stable across spawns, because agent reuse compares the MCP config, and it is revoked when the thread is deleted.
- Codex gets the entry translated into its `mcp_servers` config (`core/src/agents/codex-mcp.ts`). The token travels in an environment variable (`bearer_token_env_var`), never in `--config` arguments.
- Agents that do not speak MCP (LLM API providers) get no browser tools.

Tool names are `mcp__funny_browser__<tool>`:

| Tool                                                 | Purpose                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `browser_open`                                       | Open or reuse the thread's session; optional `url`, `profile`                                                       |
| `browser_navigate`                                   | `url`, or `action: back \| forward \| reload`                                                                       |
| `browser_snapshot`                                   | Accessibility tree with `[ref=eN]` ids; `screenshot: true` adds a JPEG                                              |
| `browser_act`                                        | `click`, `double_click`, `hover`, `type`, `fill`, `select`, `press`, `scroll`, `drag`, `upload` by `ref` or `x`/`y` |
| `browser_evaluate`                                   | JavaScript expression in the page (promises awaited, JSON result)                                                   |
| `browser_wait_for`                                   | `text`, `textGone`, `url`, `ref`, or `timeMs`                                                                       |
| `browser_status`                                     | URL, title, profile, viewport, controller, recent page errors                                                       |
| `browser_resize`                                     | Viewport size (the panel rescales via `browser-session:viewport`)                                                   |
| `browser_close`                                      | Close the thread's session                                                                                          |
| `browser_dialog`                                     | Answer the pending JavaScript dialog: `accept`, optional `promptText`                                               |
| `browser_set_appearance`                             | Emulate `colorScheme: light \| dark`                                                                                |
| `browser_recording_start` / `browser_recording_stop` | Record the viewport to an MP4 in the user's assets directory                                                        |

- **Refs expire.** A ref is valid only if it is in the latest snapshot and the page has not navigated since. Otherwise the tool returns `stale-ref` (`snapshot-refs.ts`).
- **Refs also expire** when control changes hands (see below).
- **Errors** start with a stable code: `no-browser-session`, `stale-ref`, `action-timeout`, `evaluate-failed`, `too-many-sessions`, `browser-unavailable`, `invalid-arguments`, `action-failed`, `user-has-control`, `dialog-pending`, `path-not-allowed`, `recording-unavailable`.
- **URLs.** Only `http(s)`, `about:` and `data:` URLs are accepted. Bare hosts get `https://` (`http://` for localhost).
- **Dialogs** (`alert`, `confirm`, `prompt`, `beforeunload`) are held, not dismissed. The action that opened one returns "… triggered a dialog" with its type and message. Until the agent (`browser_dialog`) or the user (panel) answers it, page tools fail with `dialog-pending`.
- **Upload.** `browser_act { action: 'upload', ref, paths }` sets files on a file input. Relative paths resolve against the thread's working directory; anything outside it fails with `path-not-allowed`.
- **Recording.** `browser_recording_start` collects the screencast frames (plus one captured frame at start and stop, since static pages emit none). `browser_recording_stop` encodes them with `ffmpeg` (libx264, variable frame rate) to `browser-recording-<thread>-<time>.mp4` in the user's assets directory, and the tool card plays it inline. It is capped at 10 minutes or 6000 frames. Without an `ffmpeg` that has libx264 on `PATH`, both tools return `recording-unavailable`.
- **Popups** become the active tab. When a popup closes itself, the session returns to the opener.
- **Permissions.** For Claude, `funny_browser` is in `PERMISSION_GATED_MCP_SERVERS` (`packages/core/src/agents/sdk-claude.ts`), so its tools follow the thread's permission mode instead of the blanket MCP auto-allow. Codex asks for approval before every MCP call, and its SDK mode cannot prompt anyone, so Funny pre-approves the tools (`default_tools_approval_mode = "approve"`). In `plan` mode it does not, and the calls fail as "requires approval".
- **Kill switch.** Set `FUNNY_BROWSER_TOOLS=0` on the runner to stop injecting the server and the `$BROWSER` bridge. The panel keeps working.

## Shared control

The agent controls a thread session by default. In the panel, **Take over** hands the page to the user, and **Hand back to agent** returns it. These are `browser-session:input { kind: 'takeControl' | 'releaseControl' }`. While the user has control:

- page-changing tools (`browser_navigate`, `browser_act`, `browser_evaluate`, `browser_resize`, `browser_set_appearance`, `browser_dialog`) fail with `user-has-control`;
- `browser_snapshot`, `browser_status` and `browser_wait_for` keep working.

Every change of control invalidates the agent's refs. The runner emits `browser-session:controller`. A pending dialog is shown in the panel with OK / Cancel (and an input for `prompt`), and answered with `browser-session:input { kind: 'dialog', accept, promptText }`. On (re)attach, `ready` is followed by the current controller and any pending dialog, so the panel never shows a stale state.

## `$BROWSER` bridge (CLI logins)

Commands the agent runs, such as `wrangler login` or `gh auth login --web`, open URLs through `$BROWSER`. `xdg-open` also uses it when no desktop environment is detected. `open-url-bridge.ts` sets the following in every agent spawn (via `buildAgentEnv`):

- `BROWSER=<data dir>/bin/funny-open-url`, a small `sh` shim;
- `FUNNY_THREAD_ID`;
- `FUNNY_BROWSER_OPEN_DIR=<data dir>/browser-open/<userId>`, mode `0700`.

The shim writes one `<threadId>\n<url>` file per URL. The runner watches that directory, checks that the thread belongs to the user, and opens the URL in the thread's session. That emits `agent-opened`, so the panel shows it, and an OAuth callback to `localhost` reaches the CLI on the runner. CLIs that ignore `$BROWSER` and only print the URL still need the agent to call `browser_open` with that URL.

## Client

`stores/browser-panel-store.ts` keeps `sessionThreadId`, `viewport`, `controller` and `dialog`. `BrowserControlBar` renders the controller badge, Take over / Hand back button and the dialog prompt. When the agent opens a session on the thread being viewed (`browser-session:agent-opened`), the panel opens and attaches. Switching threads detaches the previous thread's session and probes the new one (`open` with an empty URL replies `ready`, or `closed { reason: 'not_found' }`). Tool calls render as "Browser · …" cards with a _Show in browser panel_ button (`components/tool-cards/mcp-tool.ts`).
