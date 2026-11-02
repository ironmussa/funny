# Agent browser (shared browser sessions)

Agents can drive a real Chromium on the user's runner — the same browser the user watches in the Browser Panel. Use it for web tasks such as dashboards, OAuth logins or checking a deployed page, instead of a system browser or a separately launched one. Spec: `openspec/changes/agent-browser-automation/`.

## Session model

- **One Chromium per user, one tab per session.** `packages/runtime/src/services/browser-automation/browser-host.ts` launches headless Chromium on a persistent profile and connects Playwright (`connectOverCDP`). Each session is a tab. The panel's `ChromeSession` (`@funny/core/chrome`) attaches to the same tab by CDP target id for screencast and input, while the agent drives it through Playwright. Panel input and agent actions are serialised per tab.
- **Panel-owned sessions** (random id) close with the panel or after a 90 s heartbeat loss.
- **Thread-bound sessions** (id `thread:<threadId>`, see `threadBrowserSessionId` in `@funny/shared`) are shared between a thread's agent and the panel. Closing the panel only detaches. They close on `browser_close`, "Close browser session" in the panel, 15 min with no agent call and no panel, thread delete/archive, or runner shutdown.
- **Isolation.** Every panel message is checked against the session's owner, and agent tools only reach their own thread's session (`threadId` / `userId` come from the spawn, never from the model).
- **Identity.** Chromium reports `Chrome/<major>.0.0.0` instead of `HeadlessChrome/…` (`user-agent.ts`). This is identity normalisation only: CAPTCHAs and two-factor prompts are solved by the user in the panel.

## Profile on disk

- Location: `<FUNNY_DATA_DIR or ~/.funny>/browser-profiles/<userId>/default` on the runner, mode `0700`. It holds cookies, local storage and logins, so sites stay signed in across sessions and runner restarts.
- `browser_open { profile: 'ephemeral' }` opens an isolated, incognito-like context instead. It is discarded on close.
- **Clear browser profile** (panel `…` menu → _Clear browser profile…_) closes every session of the user, stops Chromium and deletes the profile directory. The client sends `browser-session:close { reason: 'clear-profile' }`.

## Agent tools (`funny_browser` MCP server)

Built per spawn in `browser-mcp-server.ts` and injected by `withBrowserMcpServer` (`agent-startup/agent-profile.ts`) for **Claude** spawns. Tool names are `mcp__funny_browser__<tool>`:

| Tool               | Purpose                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `browser_open`     | Open or reuse the thread's session; optional `url`, `profile`                                             |
| `browser_navigate` | `url`, or `action: back \| forward \| reload`                                                             |
| `browser_snapshot` | Accessibility tree with `[ref=eN]` ids; `screenshot: true` adds a JPEG                                    |
| `browser_act`      | `click`, `double_click`, `hover`, `type`, `fill`, `select`, `press`, `scroll`, `drag` by `ref` or `x`/`y` |
| `browser_evaluate` | JavaScript expression in the page (promises awaited, JSON result)                                         |
| `browser_wait_for` | `text`, `textGone`, `url`, `ref`, or `timeMs`                                                             |
| `browser_status`   | URL, title, profile, viewport, controller, recent page errors                                             |
| `browser_resize`   | Viewport size (the panel rescales via `browser-session:viewport`)                                         |
| `browser_close`    | Close the thread's session                                                                                |

- **Refs expire.** A ref is valid only if it is in the latest snapshot and the page has not navigated since. Otherwise the tool returns `stale-ref` (`snapshot-refs.ts`).
- **Errors** start with a stable code: `no-browser-session`, `stale-ref`, `action-timeout`, `evaluate-failed`, `too-many-sessions`, `browser-unavailable`, `invalid-arguments`, `action-failed`.
- **URLs.** Only `http(s)`, `about:` and `data:` URLs are accepted. Bare hosts get `https://` (`http://` for localhost).
- **Dialogs** are dismissed automatically and reported in the next tool result.
- **Popups** become the active tab. When a popup closes itself, the session returns to the opener.
- **Permissions.** `funny_browser` is in `PERMISSION_GATED_MCP_SERVERS` (`packages/core/src/agents/sdk-claude.ts`), so its tools follow the thread's permission mode instead of the blanket MCP auto-allow.
- **Kill switch.** Set `FUNNY_BROWSER_TOOLS=0` on the runner to stop injecting the server. The panel keeps working.

## Client

`stores/browser-panel-store.ts` keeps `sessionThreadId` and `viewport`. When the agent opens a session on the thread being viewed (`browser-session:agent-opened`), the panel opens and attaches. Switching threads detaches the previous thread's session and probes the new one (`open` with an empty URL replies `ready`, or `closed { reason: 'not_found' }`). Tool calls render as "Browser · …" cards with a _Show in browser panel_ button (`components/tool-cards/mcp-tool.ts`).
