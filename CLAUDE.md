# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

funny is a web UI for orchestrating multiple Claude Code agents in parallel. It uses git worktrees to let each agent work on its own branch simultaneously without conflicts. Think of it as a Codex App clone powered by the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).

## Installation & Running

### For End Users

```bash
# Quick start (no installation)
bunx funny

# Or install globally
bun install -g funny
funny

# CLI options
funny --port 8080              # Custom port
funny --help                   # Show all options
```

### For Development

```bash
# Install dependencies (Bun workspaces)
bun install

# Run both server and client in development
bun run dev

# Run only the server (Hono + Bun watch, port 3001)
bun run dev:server

# Run only the client (Vite, port 5173)
bun run dev:client

# Build all packages
bun run build

# Start from built files (production mode)
bun start

# Push database schema (Drizzle + SQLite)
bun run db:push

# Open Drizzle Studio for database inspection
bun run db:studio
```

## Architecture

### Monorepo Structure (Bun workspaces)

- **`packages/shared`** — TypeScript types and error definitions (no runtime code). Exports from `src/types.ts` and `src/errors.ts`. Contains interfaces for Project, Thread, Message, ToolCall, FileDiff, WebSocket events, and API request/response types.
- **`packages/core`** — Pure logic shared across server and runtime. Contains git operations (`git/`), agent process management (`agents/`), container/sandbox support (`containers/`), and port allocation (`ports/`). No HTTP or database code.
- **`packages/runtime`** — Hono HTTP routes and services for agent execution. Manages agent runners, PTY sessions, worktrees, pipelines, and WebSocket broadcasting. Acts as the "runner" in the server+runner architecture.
- **`packages/server`** — Entry point for the application. Handles authentication (Better Auth), database (Drizzle + SQLite/PostgreSQL), user management, and proxies requests to remote runners. Owns all persistent state.
- **`packages/client`** — React 19 + Vite SPA. Runs on port 5173 with a proxy to the server at `/api`.

### Server Architecture

**Entry point:** `packages/server/src/index.ts` — Initializes auth, database, and starts `Bun.serve()` with WebSocket support. All agent/filesystem/git operations are proxied to remote runners connected via WebSocket tunnel.

**Database:** SQLite via `bun:sqlite` (Bun's native SQLite driver) + Drizzle ORM. DB file lives at `~/.funny/data.db`. Tables are auto-created on startup via `db/migrate.ts` (raw SQL, not Drizzle migrations). Schema in `db/schema.ts` defines: `projects`, `threads`, `messages`, `tool_calls`.

**Key services (runtime):**

- `agent-runner.ts` — Spawns agent processes via `packages/core/src/agents/`. Persists messages/tool_calls and emits WebSocket events via `ws-broker`. Supports session resumption.
- `ws-broker.ts` — Singleton pub/sub that broadcasts WebSocket events to all connected clients. Single multiplexed stream (not per-thread).
- `pipeline-manager.ts` — Manages multi-step agent pipelines.
- `pty-manager.ts` — Terminal/PTY session management with multiple backends (headless-xterm, bun-native, node-pty).
- `automation-manager.ts` — Scheduled and event-driven automation execution.

**Key services (server):**

- `project-manager.ts` — CRUD for projects. Validates that the path is a git repo before creating.
- `runner-manager.ts` — Manages remote runner instances (registration, heartbeat, project assignments).
- `project-repository.ts`, `thread-event-repository.ts`, etc. — Database repositories for persistent state.

**Core modules (`packages/core/src/`):**

- `git/process.ts` — Cross-platform process execution with concurrency pools (`gitRead`, `gitWrite`, `execute`). All git and shell commands go through this.
- `git/git.ts` — High-level git operations (diff, stage, commit, push, branch management).
- `git/worktree.ts` — Git worktree create/list/remove operations.
- `git/github.ts` — GitHub CLI (`gh`) integration for PRs and repo operations.
- `agents/` — Agent process factories and providers (Claude SDK, Codex, Gemini ACP, LLM API).

**Route groups:**

- `/api/projects` — CRUD + branch listing
- `/api/threads` — CRUD + start/stop agents + send follow-up messages
- `/api/git/:threadId/*` — Diff, stage, unstage, revert, commit, push, create PR
- `/ws` — WebSocket endpoint (multiplexed for all threads)
- `/api/browse` — Filesystem browsing (drive roots, directory listing, repo name detection, git init)

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

The app always uses [Better Auth](https://www.better-auth.com/) with cookie-based sessions. On first startup, a default admin account is created automatically:

- **Username:** `admin`
- **Password:** `admin`

The admin can create additional users from **Settings > Users** in the UI. Self-registration is disabled.

**Key details:**

- Sessions expire after 7 days
- Auth secret is auto-generated and stored at `~/.funny/auth-secret`
- Each user only sees their own projects, threads, and automations
- WebSocket events are filtered per user
- SQLite is the default database; PostgreSQL is optional (set `DATABASE_URL`)

### Deployment Architecture

The server and runner are **always separate processes** — the runner is never embedded in the server.

- **Server** (`packages/server`) — Handles authentication, serves the client UI, and owns the database. Proxies all agent/filesystem/git requests to runners. The server is the single entry point for all client requests.
- **Runner** (`packages/runtime`) — Stateless process that executes agent work (spawning Claude CLI processes, managing git worktrees, PTY sessions). Runners connect to the server via WebSocket tunnel and can work behind NAT. The runner has **no database** — all data is proxied to the server via the WebSocket data channel.

Data flow: `Client → Server → Runner (via WS tunnel or direct HTTP)`

Configuration:
- `TEAM_SERVER_URL` — **Required** on the runner to connect it to the server
- `RUNNER_AUTH_SECRET` — **Required** shared secret for runner ↔ server authentication
- `DATABASE_URL` — Optional PostgreSQL connection string on the server (default: SQLite at `~/.funny/data.db`)

### Per-User Git Identity

Each user can configure their own git identity and GitHub credentials from **Settings > Profile**:

- **Git Name / Email** — Used as `--author` on commits and merges
- **GitHub Personal Access Token** — Used as `GH_TOKEN` for push and PR operations

Tokens are encrypted at rest using **AES-256-GCM**. The encryption key is auto-generated on first use and stored at:

```
~/.funny/encryption.key
```

> **Important:** If this file is deleted, any previously saved GitHub tokens become unrecoverable. Back it up if needed. The file is created with restricted permissions (`0600`).

### Auth Architecture

- `packages/runtime/src/lib/auth.ts` — Better Auth instance (initialized by the server on startup)
- `packages/server/src/middleware/auth.ts` — Server auth middleware (validates sessions, sets user context)
- `packages/runtime/src/middleware/auth.ts` — Runtime auth middleware (validates `X-Runner-Auth` shared secret from server proxy, falls back to server session validation)
- `packages/client/src/stores/auth-store.ts` — Client auth state (session-based login/logout)
- `packages/client/src/lib/auth-client.ts` — Better Auth client with username + admin plugins

## TypeScript

**Always use `bun` for type checking instead of `tsc`.** This project uses Bun as its runtime and Bun includes a built-in TypeScript type checker. Do not install or use `tsc` / `typescript` CLI directly.

```bash
# Type check a specific package
cd packages/runtime && bun --check src/index.ts

# Or use bunx to check files
bunx tsc --noEmit
```

## Key Patterns

### Runner Isolation (CRITICAL)

**Requests MUST only be routed to the runner that belongs to the requesting user.** Never fall back to a different user's runner, even if that runner is online and connected. This is a hard security boundary — each user's runner has access to their local filesystem, git credentials, and environment. Routing a request to another user's runner would leak data across tenant boundaries. If the user's runner is unavailable, return a 502 — do NOT try another runner.

- Thread modes: `local` runs the agent in the project directory; `worktree` creates a git worktree with an isolated branch
- All git operations use async functions from `packages/core/src/git/` — use `gitRead`/`gitWrite` for git commands and `execute` for general process execution from `git/process.ts`
- The agent runner spawns agent processes via `packages/core/src/agents/` and stores a session ID for resuming conversations
- WebSocket events carry a `threadId` field so the client can associate updates with the correct thread
- The model selector maps friendly names (sonnet/opus/haiku) to full model IDs in `agent-runner.ts`

### Error Handling with `neverthrow`

**Always prefer `neverthrow` for error handling over try/catch when possible.** The `neverthrow` library is already installed across all packages and widely used in the codebase. Use `Result<T, E>`, `ok()`, and `err()` to represent fallible operations instead of throwing exceptions.

```typescript
import { Result, ok, err } from 'neverthrow';

function parseConfig(raw: string): Result<Config, string> {
  // return ok(config) on success, err("message") on failure
}
```

- Use `ResultAsync` for async operations that can fail
- Chain results with `.map()`, `.mapErr()`, `.andThen()` instead of nested try/catch
- Reserve try/catch for boundaries (route handlers, top-level entry points) or third-party code that throws
- On the server, use `result-response.ts` helpers to convert `Result` values into HTTP responses

## Agent Safety Rules

**NEVER start dev servers or long-running processes.** You are running headlessly without a browser — commands like `bun run dev`, `npm run dev`, `yarn dev`, `bun --watch`, or `vite` will hang forever and may kill the main development server via `kill-port.ts`.

To verify your changes compile correctly, use build or type-check commands instead:

```bash
# Check that the client builds without errors
bun run build

# Type-check a specific file
bun --check packages/runtime/src/index.ts

# Type-check the whole project
bunx tsc --noEmit
```

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
cd packages/client && bunx shadcn@latest add <component>
```

Do NOT create a manual implementation of a component that shadcn/ui provides.

### Use `cn()` for class names

Always use the `cn()` helper from `@/lib/utils` to compose Tailwind classes. Never use raw string concatenation for conditional classes.

### No additional UI libraries

Do not install other component libraries (Material UI, Ant Design, Chakra UI, Mantine, etc.). All UI must be built with shadcn/ui + Tailwind CSS + Radix UI primitives.

### Always add `data-testid` attributes

Every interactive element (buttons, inputs, selects, checkboxes, toggles, clickable areas) MUST include a `data-testid` attribute for Playwright E2E testing. Use kebab-case with an area prefix:

```tsx
// Static IDs
<Button data-testid="sidebar-add-project" />
<Input data-testid="new-thread-prompt" />

// Dynamic IDs (per-entity)
<div data-testid={`project-item-${project.id}`} />
<button data-testid={`thread-item-${thread.id}`} />
```

Naming convention: `{area}-{element}-{qualifier}`. Examples: `sidebar-search`, `review-commit-title`, `kanban-card-{id}`.

### Import from `@/components/ui/`

All base component imports must come from `@/components/ui/`. Example:

```tsx
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
```
