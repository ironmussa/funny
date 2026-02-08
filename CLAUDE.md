# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

a-parallel is a web UI for orchestrating multiple Claude Code agents in parallel. It uses git worktrees to let each agent work on its own branch simultaneously without conflicts. Think of it as a Codex App clone powered by the Claude Agent SDK.

## Commands

```bash
# Install dependencies (npm workspaces)
npm install

# Run both server and client in development
npm run dev

# Run only the server (Hono + tsx watch, port 3001)
npm run dev:server

# Run only the client (Vite, port 5173)
npm run dev:client

# Build all packages
npm run build

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

**Database:** SQLite via better-sqlite3 + Drizzle ORM. DB file lives at `~/.a-parallel/data.db`. Tables are auto-created on startup via `db/migrate.ts` (raw SQL, not Drizzle migrations). Schema in `db/schema.ts` defines: `projects`, `threads`, `messages`, `tool_calls`.

**Key services:**
- `agent-runner.ts` — Spawns Claude CLI processes via `claude-process.ts`. Parses NDJSON stream output, persists messages/tool_calls to DB, and emits WebSocket events via `ws-broker`. Supports session resumption.
- `claude-process.ts` — Manages a single Claude CLI process (`claude --print --output-format stream-json`). Reads NDJSON stdout, emits typed messages.
- `worktree-manager.ts` — Creates/lists/removes git worktrees in a `.a-parallel-worktrees` directory adjacent to the project. Uses synchronous git operations.
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

## Key Patterns

- Thread modes: `local` runs the agent in the project directory; `worktree` creates a git worktree with an isolated branch
- All git operations in route handlers should use async functions from `git-v2.ts`, never the legacy `git.ts`
- The agent runner spawns Claude CLI processes (not direct API calls) and stores a session ID for resuming conversations
- WebSocket events carry a `threadId` field so the client can associate updates with the correct thread
- The model selector maps friendly names (sonnet/opus/haiku) to full model IDs in `agent-runner.ts`
