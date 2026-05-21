# @funny/client

React 19 single-page application for managing and monitoring parallel Claude Code agents. Built with Vite, Tailwind CSS, and shadcn/ui.

## Quick Start

```bash
# From monorepo root
bun run dev:client

# Or directly
bunx vite
```

Client runs on **http://localhost:5173** with an API proxy to port 3001.

## Architecture

```
src/
├── main.tsx                    # Entry point — AuthGate, router, providers
├── App.tsx                     # Root layout with responsive shell
├── components/
│   ├── Sidebar.tsx             # Project list, thread list, user section
│   ├── ThreadView.tsx          # Chat-style message display + tool call cards
│   ├── PromptInput.tsx         # Message input with model/mode selectors
│   ├── ReviewPane.tsx          # Git diff viewer + stage/commit/push/PR actions
│   ├── NewThreadDialog.tsx     # Thread creation dialog
│   ├── ToolCallCard.tsx        # Collapsible tool call visualization
│   ├── TerminalPanel.tsx       # Embedded xterm.js terminal
│   ├── PreviewBrowser.tsx      # In-app browser preview (iframe)
│   ├── CommandPalette.tsx      # Quick navigation (Cmd+K)
│   ├── LoginPage.tsx           # Authentication form (multi mode)
│   ├── AllThreadsView.tsx      # Cross-project thread search
│   ├── AutomationSettings.tsx  # Automation CRUD + scheduling
│   ├── AutomationInboxView.tsx # Automation run notifications
│   ├── McpServerSettings.tsx   # MCP server management
│   ├── SkillsSettings.tsx      # Skill management
│   ├── WorktreeSettings.tsx    # Worktree overview
│   ├── SettingsPanel.tsx       # Settings navigation sidebar
│   ├── SettingsDetailView.tsx  # Settings page router
│   ├── settings/
│   │   ├── ProfileSettings.tsx # Git identity + GitHub token config
│   │   └── UserManagement.tsx  # Admin user management
│   ├── sidebar/                # Sidebar sub-components
│   └── ui/                     # shadcn/ui primitives
├── stores/
│   ├── app-store.ts            # Core app state (projects, threads, UI)
│   ├── auth-store.ts           # Auth state (mode, user, login/logout)
│   ├── settings-store.ts       # User preferences (theme, editor, defaults)
│   ├── review-pane-store.ts    # Diff state for the review pane
│   ├── git-status-store.ts     # Bulk git status polling
│   ├── automation-store.ts     # Automation inbox state
│   └── project-store.ts        # Project-specific state
├── hooks/
│   ├── use-ws.ts               # WebSocket connection + event dispatching
│   └── use-auto-refresh-diff.ts # Auto-refresh diffs on agent activity
├── lib/
│   ├── api.ts                  # HTTP client (neverthrow-wrapped fetch)
│   ├── auth-client.ts          # Better Auth client (multi mode)
│   └── utils.ts                # cn() helper (clsx + tailwind-merge)
└── locales/
    ├── en/translation.json     # English
    ├── es/translation.json     # Spanish
    └── pt/translation.json     # Portuguese
```

## Key Features

### Real-Time Agent Streaming

WebSocket connection at `/ws` receives all agent events — messages, tool calls, status changes, git updates — and dispatches them to the appropriate Zustand stores. Events are filtered per-user in multi-user mode.

### Chat Interface

Messages stream in real time with markdown rendering (react-markdown + remark-gfm). Tool calls appear as collapsible cards showing the tool name, a human-readable summary, and expandable JSON input/output.

### Code Review

The ReviewPane shows git diffs with syntax highlighting (react-diff-viewer), file-level stage/unstage/revert controls, commit message input with AI generation, and one-click push and PR creation.

### Command Palette

`Cmd+K` / `Ctrl+K` opens a fuzzy search across all projects and settings pages (powered by cmdk).

### State Management

Six Zustand stores with clear separation of concerns. No global re-renders — each component subscribes to exactly the slices it needs.

### Dual Auth Mode

The `AuthGate` in `main.tsx` detects the server's auth mode and either auto-authenticates (local mode) or shows a login page (multi mode). The API client automatically switches between bearer tokens and session cookies.

## Styling

- **Tailwind CSS 3** with CSS variable-based theming
- **shadcn/ui** components (Radix primitives + Tailwind)
- **Three themes:** Light, Dark, System
- **Responsive:** Sidebar collapses on mobile, components adapt to screen size
- `cn()` utility from `lib/utils.ts` (clsx + tailwind-merge)

## Path Aliases

`@/` maps to `src/` — configured in both `vite.config.ts` and `tsconfig.json`.

```tsx
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
```

## Logging & Telemetry

The client ships logs, metrics and traces to [Abbacchio](https://abbacchio.dev) via OTLP. Instrumentation is **permanent** — we don't add/remove log lines per investigation. Instead, every call site picks the right level once, and visibility is controlled at runtime.

### How it works

- **Logger:** `createClientLogger(namespace)` from `@/lib/client-logger.ts` returns a namespaced logger with `.error / .warn / .info / .debug / .trace` methods.
- **Metrics & spans:** `metric(name, value, { attributes })` and `startSpan(name, { attributes })` from `@/lib/telemetry.ts`.
- **OTLP endpoint:** set via `VITE_OTLP_ENDPOINT`. When unset, logging is a no-op (safe to run offline).

### Levels and when they fire

| Level   | Use for                                                          | Prod default |
| ------- | ---------------------------------------------------------------- | ------------ |
| `error` | Unexpected failure paths                                         | **on**       |
| `warn`  | Recoverable anomalies, unexpected branches                       | **on**       |
| `info`  | Per-session milestones (WS connect, `agent:result`, route change)| **on**       |
| `debug` | High-frequency traces (every WS chunk, RAF flush, status txn)    | off          |
| `trace` | Extreme detail (per-keystroke, per-frame)                        | off          |

In dev the floor is `debug` (everything visible). In prod the floor is `info` — `debug` and `trace` are dropped unless you opt in.

### Turning logs on/off in production (no redeploy)

Open DevTools console on the production site and run:

```js
// Raise the global floor — see every debug line from every namespace
__funnyLog.setLevel('debug');

// Raise just one namespace — e.g. only WebSocket traces
__funnyLog.setNamespaceLevel('ws', 'debug');

// Reset back to defaults (info in prod, debug in dev)
__funnyLog.clear();
```

The setting persists across reloads via `localStorage`. Reload after changing the level so loggers created at module-init pick it up.

You can also set the keys directly:

| Key                          | Value                                            | Effect                          |
| ---------------------------- | ------------------------------------------------ | ------------------------------- |
| `funny:log-level`            | `trace` \| `debug` \| `info` \| `warn` \| `error`| Global floor                    |
| `funny:log-ns:<namespace>`   | same as above                                    | Override one namespace          |

Example: `localStorage.setItem('funny:log-ns:ws', 'debug')` and reload to debug just the WebSocket layer in production.

### When to use a metric vs. a log

- "X happened with value Y, and I want it always visible" → **metric**, not a log. Metrics are orders of magnitude cheaper and graphable in Abbacchio.
- Causal chain across async boundaries (event arrived → store applied) → **span** via `startSpan`.
- Discrete milestone or unexpected condition → `info` / `warn` / `error` log.

### Permanent diagnostic instrumentation

These exist to diagnose production-only issues without redeploying. They're documented in `packages/client/CLAUDE.md` so future contributors don't remove them:

- `ws.connected` (counter, `transport`) — fires on every Socket.IO connect. Surfaces reverse-proxy WS-upgrade failures (a `transport=polling` sample is the smoking gun for dropped trailing events).
- `ws.transport_upgrade` (counter, `transport`) — fires when polling upgrades to websocket.
- `ws.result_received` (counter, `status`) — fires on every `agent:result`. Lets you distinguish "event never arrived" from "event arrived but UI didn't update".
- `ws.dispatch_result` (span, `status`) — wraps the result-to-store-applied path. Surfaces React 19 transition lag.

## Scripts

```bash
bun run dev       # Start Vite dev server (port 5173)
bun run build     # Type-check (tsc -b) + production build
bun run preview   # Preview production build
bun run test      # Run Vitest tests
```

## Tech Stack

- **UI:** [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **Build:** [Vite 6](https://vite.dev/)
- **Styling:** [Tailwind CSS 3](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)
- **State:** [Zustand 5](https://github.com/pmndrs/zustand)
- **Routing:** [React Router 7](https://reactrouter.com/)
- **i18n:** [i18next](https://www.i18next.com/) + [react-i18next](https://react.i18next.com/)
- **Terminal:** [xterm.js 6](https://xtermjs.org/)
- **Animations:** [Motion](https://motion.dev/)
- **Auth:** [Better Auth](https://www.better-auth.com/) (client)
