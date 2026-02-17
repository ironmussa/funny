# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

funny is a web UI for orchestrating multiple Claude Code agents in parallel. It uses git worktrees to let each agent work on its own branch simultaneously without conflicts. Think of it as a Codex App clone powered by the Claude Agent SDK.

## Installation & Running

### For End Users

```bash
# Quick start (no installation)
npx funny

# Or install globally
npm install -g funny
funny

# CLI options
funny --port 8080              # Custom port
funny --auth-mode multi        # Multi-user mode
funny --help                   # Show all options
```

### For Development

```bash
# Install dependencies (npm workspaces)
npm install

# Run both server and client in development
npm run dev

# Run only the server (Hono + Bun watch, port 3001)
npm run dev:server

# Run only the client (Vite, port 5173)
npm run dev:client

# Build all packages
npm run build

# Start from built files (production mode)
npm start

# Push database schema (Drizzle + SQLite)
npm run db:push

# Open Drizzle Studio for database inspection
npm run db:studio
```

## Architecture

### Monorepo Structure (npm workspaces)

- **`packages/shared`** — TypeScript types only (no runtime code). Exports from `src/types.ts`. Contains interfaces for Project, Thread, Message, ToolCall, FileDiff, WebSocket events, and API request/response types.
- **`packages/server`** — Hono HTTP server with the Claude Agent SDK. Runs on port 3001 via `tsx watch`.
- **`packages/client`** — React 19 + Vite SPA. Runs on port 5173 with a proxy to the server at `/api`.

### Server Architecture

**Entry point:** `packages/server/src/index.ts` — Hono app with CORS, logger middleware, and route groups mounted under `/api`. WebSocket upgrade at `/ws`.

**Database:** SQLite via better-sqlite3 + Drizzle ORM. DB file lives at `~/.funny/data.db`. Tables are auto-created on startup via `db/migrate.ts` (raw SQL, not Drizzle migrations). Schema in `db/schema.ts` defines: `projects`, `threads`, `messages`, `tool_calls`.

**Key services:**
- `agent-runner.ts` — Spawns Claude CLI processes via `claude-process.ts`. Parses NDJSON stream output, persists messages/tool_calls to DB, and emits WebSocket events via `ws-broker`. Supports session resumption.
- `claude-process.ts` — Manages a single Claude CLI process (`claude --print --output-format stream-json`). Reads NDJSON stdout, emits typed messages.
- `worktree-manager.ts` — Creates/lists/removes git worktrees in a `.funny-worktrees` directory adjacent to the project. Uses synchronous git operations.
- `ws-broker.ts` — Singleton pub/sub that broadcasts WebSocket events to all connected clients. Single multiplexed stream (not per-thread).
- `project-manager.ts` — CRUD for projects. Validates that the path is a git repo before creating.
- `diff-service.ts` — Re-exports from `git-v2.ts` for backward compatibility.

**Route groups:**
- `/api/projects` — CRUD + branch listing
- `/api/threads` — CRUD + start/stop agents + send follow-up messages
- `/api/git/:threadId/*` — Diff, stage, unstage, revert, commit, push, create PR
- `/ws` — WebSocket endpoint (multiplexed for all threads)
- `/api/browse` — Filesystem browsing (drive roots, directory listing, repo name detection, git init)

**Process execution:** Two layers exist — legacy `utils/git.ts` (execSync, string-based) and the current `utils/git-v2.ts` + `utils/process.ts` (execa, array-based arguments). New code should always use `git-v2.ts`. See `PROCESS-EXECUTION-STRATEGY.md` for context.

### Client Architecture

**State management:** Zustand store in `stores/app-store.ts`. Holds projects, threads, active thread with messages, and UI state (selected IDs, pane visibility).

**Real-time updates:** `hooks/use-ws.ts` connects to `/ws` and dispatches WebSocket events to the store (agent:message, agent:status, agent:result, agent:tool_call).

**UI components:** Built with shadcn/ui (Radix UI primitives + Tailwind). Components in `components/ui/` include Button, Select, Dialog, ScrollArea, Tooltip, and Collapsible.

**Key components:**
- `Sidebar` — Project list with collapsible accordion, thread list with status badges, folder picker for adding projects
- `NewThreadDialog` — Thread creation with mode (local/worktree), model (haiku/sonnet/opus), branch selection, and prompt
- `ThreadView` — Chat-style message display with tool call cards, input, stop button, and review pane toggle
- `ToolCallCard` — Collapsible card showing tool name, summary, and expandable JSON input
- `ReviewPane` — Git diff viewer with stage/unstage/revert/commit/push/PR actions
- `PromptInput` — Textarea with model/mode selectors (shadcn Select) and send/stop buttons

**Styling:** Tailwind CSS 3 with CSS variable-based theming (shadcn/ui). Uses `cn()` utility from `lib/utils.ts` (clsx + tailwind-merge). Custom scrollbar styles and animations defined in `globals.css` and `tailwind.config.ts`.

**Path alias:** `@/` maps to `packages/client/src/` (configured in both vite.config.ts and tsconfig.json).

## Authentication

The app supports two authentication modes controlled by the `AUTH_MODE` environment variable.

### Local Mode (default)

Single-user mode. No login page. A bearer token is auto-generated and stored at `~/.funny/auth-token`. This is the default when `AUTH_MODE` is not set.

```bash
# Just start normally — no configuration needed
npm run dev
```

### Multi-User Mode

Multiple users with login page, per-user data isolation, and admin-managed accounts. Uses [Better Auth](https://www.better-auth.com/) with cookie-based sessions stored in the same SQLite database.

```bash
# Set the environment variable before starting the server
AUTH_MODE=multi npm run dev
```

On first startup in multi mode, a default admin account is created automatically:
- **Username:** `admin`
- **Password:** `admin`

The admin can create additional users from **Settings > Users** in the UI. Self-registration is disabled.

**Key details:**
- Sessions expire after 7 days
- Auth secret is auto-generated and stored at `~/.funny/auth-secret`
- Each user only sees their own projects, threads, and automations
- WebSocket events are filtered per user
- Legacy data (created in local mode) is reassigned to the first admin on login

### Per-User Git Identity (Multi-User Only)

In multi-user mode, each user can configure their own git identity and GitHub credentials from **Settings > Profile**:

- **Git Name / Email** — Used as `--author` on commits and merges
- **GitHub Personal Access Token** — Used as `GH_TOKEN` for push and PR operations

Tokens are encrypted at rest using **AES-256-GCM**. The encryption key is auto-generated on first use and stored at:

```
~/.funny/encryption.key
```

> **Important:** If this file is deleted, any previously saved GitHub tokens become unrecoverable. Back it up if needed. The file is created with restricted permissions (`0600`).

In local mode, this feature is inactive — git operations use the machine's default git config.

### Auth Architecture

- `packages/server/src/lib/auth-mode.ts` — Reads `AUTH_MODE` env var
- `packages/server/src/lib/auth.ts` — Better Auth instance (only loaded in multi mode)
- `packages/server/src/middleware/auth.ts` — Dual-mode middleware (bearer token vs session cookie)
- `packages/client/src/stores/auth-store.ts` — Client auth state (mode detection, login, logout)
- `packages/client/src/lib/auth-client.ts` — Better Auth client with username + admin plugins

## TypeScript

**Always use `bun` for type checking instead of `tsc`.** This project uses Bun as its runtime and Bun includes a built-in TypeScript type checker. Do not install or use `tsc` / `typescript` CLI directly.

```bash
# Type check a specific package
cd packages/server && bun --check src/index.ts

# Or use bunx to check files
bunx tsc --noEmit
```

## Key Patterns

- Thread modes: `local` runs the agent in the project directory; `worktree` creates a git worktree with an isolated branch
- All git operations in route handlers should use async functions from `git-v2.ts`, never the legacy `git.ts`
- The agent runner spawns Claude CLI processes (not direct API calls) and stores a session ID for resuming conversations
- WebSocket events carry a `threadId` field so the client can associate updates with the correct thread
- The model selector maps friendly names (sonnet/opus/haiku) to full model IDs in `agent-runner.ts`

## UI Rules

**All UI work in `packages/client` MUST use shadcn/ui components and Tailwind CSS. These rules are mandatory.**

### Always use shadcn/ui first

Before creating any UI element, check if a shadcn/ui component already covers the need. Never build custom buttons, dialogs, dropdowns, inputs, tooltips, or similar primitives from scratch — use the existing shadcn/ui components instead.

### Installed components

The following shadcn/ui components are already installed in `packages/client/src/components/ui/`:

Badge, Breadcrumb, Button, Collapsible, Command, Dialog, DropdownMenu, Input, Popover, ScrollArea, Select, Separator, Sheet, Sidebar, Skeleton, Tooltip.

### Install new shadcn components when needed

If you need a shadcn/ui component that is not yet installed (e.g., Tabs, Accordion, Checkbox, Switch, Toggle, Card, Alert, Toast, etc.), install it first:

```bash
cd packages/client && npx shadcn@latest add <component>
```

Do NOT create a manual implementation of a component that shadcn/ui provides.

### Use `cn()` for class names

Always use the `cn()` helper from `@/lib/utils` to compose Tailwind classes. Never use raw string concatenation for conditional classes.

### No additional UI libraries

Do not install other component libraries (Material UI, Ant Design, Chakra UI, Mantine, etc.). All UI must be built with shadcn/ui + Tailwind CSS + Radix UI primitives.

### Import from `@/components/ui/`

All base component imports must come from `@/components/ui/`. Example:

```tsx
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog"
```
