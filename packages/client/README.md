# @funny/client

React 19 single-page application for managing and monitoring parallel Claude Code agents. Built with Vite, Tailwind CSS, and shadcn/ui.

## Quick Start

```bash
# From monorepo root
npm run dev:client

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
