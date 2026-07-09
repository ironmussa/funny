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

- **`packages/shared`** — Cross-package kernel. Hosts (a) types and error definitions (`src/types.ts`, `src/types/*.ts`, `src/errors.ts`, `src/models.ts`), (b) the shared DB layer used by `server` + `scheduler` (`src/db/schema.ts`, `src/db/schema.{sqlite,pg}.ts`, `src/db/adapters/{sqlite,pg}.ts`, `src/db/migrate.ts`, `src/db/connection.ts`), (c) factory-pattern repositories (`src/repositories/*.ts` — `createMessageRepository(db)`, `createThreadRepository(db)`, etc.) consumed by server + scheduler with a caller-supplied DB connection, (d) the runner↔server protocol (`src/runner-protocol.ts`), (e) auth signing helpers (`src/auth/forwarded-identity.ts`), and (f) the thread state machine (`src/thread-machine.ts`). `runtime` does NOT import the repositories — it proxies all persistence to the server via `RuntimeServiceProvider` (see Server Architecture). `client` only imports types from this package, never runtime code.
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

**State management:** Zustand stores split by concern (`stores/project-store.ts`, `stores/thread-store.ts`, `stores/ui-store.ts`) plus a backward-compatible facade `stores/app-store.ts` for legacy callers.

**Unified thread index.** Every thread row lives once in `useThreadStore.threadsById: Record<string, Thread>`. Order per bucket is preserved by sibling arrays — `threadIdsByProject: Record<string, string[]>` for project threads and `scratchThreadIds: string[]` for scratch. **Never store a Thread object in two places.** Helpers for atomic writes live in [`stores/thread-mutations.ts`](packages/client/src/stores/thread-mutations.ts) (`replaceProjectThreads`, `appendProjectThreads`, `prependScratchThread`, `removeThread`, `patchThread`, etc.); WS handlers and store actions go through these instead of touching `threadsById` directly. The helper `patchThread(state, id, updater)` also mirrors the change onto `activeThread` when the patched thread is currently active, keeping the right pane in sync without a second write.

**Read-side selectors.** Components consume threads through hooks in [`lib/thread-selectors.ts`](packages/client/src/lib/thread-selectors.ts) — never read `threadsById` / `threadIdsByProject` directly from a component:

- `useThreadById(id)` — single thread, reactive
- `useThreadsForProject(pid)` — ordered Thread[] for one project (shallow-equal)
- `useScratchThreads()` — ordered scratch list (shallow-equal)
- `useThreadsByProject()` — full `{ projectId → Thread[] }` mapping for cross-project views (Activity, Kanban, AllThreads)

Pure selectors `selectThreadById`, `selectThreadsForProject`, etc. are exported alongside for non-React code.

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

### Scratch threads

A **scratch thread** is a lightweight, projectless thread for "bounce ideas / try a regex / sketch throwaway code" workflows — same chat / tool-call / WS pipeline as a normal thread, but with no project, no git, and no worktree.

- **DB shape:** `threads` row with `is_scratch = 1`. `project_id` is `NULL`; the TS type uses `projectId: string` with `''` as the sentinel at the boundary. `Thread.isScratch` is optional at the type level (DB column is NOT NULL with default 0).
- **Working directory:** `~/.funny/scratch/<userId>/<threadId>/` on the runner. Created lazily on first agent start by `agent-lifecycle.ts`. Removed via `rm -rf` on thread delete by `thread-service/update.ts`.
- **Always `mode = 'local'`.** Worktree mode is disabled. The server route + runtime schema both reject `mode !== 'local'` with `400 scratch-thread-must-be-local`.
- **No git, ever.** `/api/git/:threadId/*` returns `400 git-not-allowed-for-scratch` for any scratch thread. The client hides the review pane, diff, commit, push, and PR affordances.
- **Per-user isolation.** Each user only sees their own scratch threads — same trust boundary as the per-user runner model. Cross-user access returns `404` via the existing ownership check.
- **Single source of truth: named predicates.** All divergence between scratch and normal threads is consolidated behind two predicate modules — DO NOT sprinkle `if (thread.isScratch)` elsewhere. When you discover a new axis of divergence, add a predicate there, not at the call site:
  - **Runtime:** `packages/runtime/src/services/thread-context.ts` — exports `resolveThreadCwd(thread, project)`, `canDoGitOps(thread)`, `scratchPathFor(userId, threadId)`. Use these in services / route handlers / agent lifecycle.
  - **Client:** `packages/client/src/lib/thread-variant.ts` — exports `isScratch(thread)`, `canDoGitOps(thread)`, `canShowPowerline(thread)`, `canConvertToWorktree(thread)`, `canFetchGitStatus(thread)`, `getThreadRoute(thread)`, `getSidebarBucket(thread)`. Use these in components / stores / hooks. The store-level helper `findThreadById(threadId)` in `stores/store-bridge.ts` provides id-based lookup when only the id is in scope.
- **Sidebar storage.** Both scratch and project threads live in the same `useThreadStore.threadsById` index — only the ordered ID arrays (`scratchThreadIds` vs `threadIdsByProject[pid]`) differentiate the buckets. WS handlers that update sidebar-visible fields MUST go through `patchSidebarThread(get, threadId, updater)` in `thread-ws-handlers.ts`, which delegates to `mutations.patchThread`. Never touch `threadsById` directly outside `thread-mutations.ts`.
- **Routing.** Compose: `/scratch/new` (triggered by `startNewScratchThread()` in `ui-store.ts`). Detail: `/scratch/:threadId`. Use `getThreadRoute(thread)` from `thread-variant.ts` to build URLs — both scratch and normal routes are covered.
- **Compose-mode flag.** `ui-store.ts` exposes `newThreadIsScratch` + `startNewScratchThread()` / `cancelNewThread()` for the new-thread input branch. `ThreadView` reads this flag to render the scratch compose UI (no `ProjectHeader`).
- **Git middleware.** `packages/runtime/src/routes/git.ts` returns `400 git-not-allowed-for-scratch` for every git request against a scratch thread. The client's `canFetchGitStatus(thread)` is the matching predicate — both layers stay aligned.
- **v1 scope.** No per-project scratch entry point, no age-based cleanup, no "promote scratch → project", no team-shared scratch. Templates/automations are allowed at the type level but not surfaced in the v1 compose UI.

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

> **Runners are not sandboxed.** A runner pointed at a remote `TEAM_SERVER_URL` effectively grants that server shell execution in the runner's `$HOME` (git ops, pre-commit hooks, Claude CLI spawn, PTY shells, access to saved GitHub tokens / provider keys). Only connect runners to central servers you trust, and prefer running each runner under a dedicated OS user / VM / container. See the **Machine B — Runner** section in [INSTALL.md](./INSTALL.md) for the full trust-boundary notes.

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

**The ONE intentional exception — steer-share delegation** (`thread-sharing-steer`). A thread shared at level `steer` lets a non-owner sharee send follow-ups (`POST /:id/message`) and read git (`status`/`diff`/`log`) on the OWNER's runner. This deliberately crosses the isolation boundary, and is allowed ONLY because every condition holds: (1) the route is on a fixed **allow-list** — a steer sharee reaches nothing else (no stop/approve/upload/rewind/convert/fork/tool-calls, no git write, never the owner's GitHub token); (2) the crossing happens in `middleware/proxy.ts` ONLY after `requireThreadSteer` has loaded + authorized the thread, then resolves the runner by `thread.userId` (owner), never a blind fallback; (3) every crossing emits the `share.steer_delegation` audit record; (4) the runtime re-authorizes via a **signed** `shareLevel`/`onBehalfOfThread` claim in the forwarded identity (it has no DB to look up the grant). Do NOT widen this allow-list or relax any of those four conditions without revisiting the change's design.md.

- Thread modes: `local` runs the agent in the project directory; `worktree` creates a git worktree with an isolated branch
- All git operations use async functions from `packages/core/src/git/` — use `gitRead`/`gitWrite` for git commands and `execute` for general process execution from `git/process.ts`
- The agent runner spawns agent processes via `packages/core/src/agents/` and stores a session ID for resuming conversations
- WebSocket events carry a `threadId` field so the client can associate updates with the correct thread
- The model selector maps friendly names (sonnet/opus/haiku) to full model IDs in `agent-runner.ts`

### Error Handling with `neverthrow`

Scoped mandate — the policy is narrow on purpose so it can actually be enforced:

- **Required** in `packages/core/**` — all fallible functions MUST return `Result<T, E>` / `ResultAsync<T, E>`. No raw `throw` in new code under `core`.
- **Required at service-method boundaries** in `packages/runtime/src/services/**` and `packages/server/src/services/**` — public methods on service classes MUST return `Result` / `ResultAsync` so callers can compose failure handling.
- **Allowed to `throw`**: Hono route handlers, top-level entry points (`src/index.ts`), test code, and third-party libraries that throw (wrap at the boundary with `Result.fromThrowable` / `ResultAsync.fromPromise`).
- **Client code**: preferred but not required; use whatever fits the call-site.

```typescript
import { Result, ok, err } from 'neverthrow';

function parseConfig(raw: string): Result<Config, string> {
  // return ok(config) on success, err("message") on failure
}
```

- Use `ResultAsync` for async operations that can fail.
- Chain results with `.map()`, `.mapErr()`, `.andThen()` instead of nested try/catch.
- On the server, use `result-response.ts` helpers to convert `Result` values into HTTP responses.

## Bug Fixes & Regression Tests

When resolving a bug or problem, always propose adding a test that covers the case (if applicable). The test should fail without the fix and pass with it, so the regression cannot silently come back. If a test is not feasible (e.g., infra-only change, trivial typo, no test harness for that area), say so explicitly instead of skipping silently.

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

### Respect the global font size setting and theme

All UI text — including code in diffs, terminals, Monaco editors, and chat messages — **MUST** scale with the user's font size setting from Settings > Appearance. Never hardcode pixel font sizes (e.g., `fontSize: 13`, `text-[11px]`). Instead:

- **Diff panels**: use `DIFF_FONT_SIZE_PX[fontSize]` and `DIFF_ROW_HEIGHT_PX[fontSize]` from `@/stores/settings-store`. These are **aligned with the Monaco editor** (`DIFF_FONT_SIZE_PX === EDITOR_FONT_SIZE_PX`, row height ≈ `round(1.5 × fontSize)`) so the diff and the code editor share one baseline — do NOT point the diff back at `CODE_*`.
- **Terminals and Monaco editors**: use `EDITOR_FONT_SIZE_PX[fontSize]` from `@/stores/settings-store`.
- **Inline code blocks in chat** (denser scale — `WaitingCards`, prose code, the `--code-font-size` var): use `CODE_FONT_SIZE_PX[fontSize]` and `CODE_LINE_HEIGHT_PX[fontSize]`. The diff no longer uses this.
- **Diff panel rendering**: use the CSS variables `--diff-font-size` and `--diff-row-height` (e.g., `text-[length:var(--diff-font-size)]`).
- **Prose / chat messages**: use `PROSE_FONT_SIZE_PX[fontSize]` and `PROSE_LINE_HEIGHT_PX[fontSize]` with the `makeProseFont()` / `makeMonoFont()` helpers from `@/hooks/use-pretext` for pretext layout measurements.
- **Terminals (xterm.js)**: read font size from the store at creation and add a reactive `useEffect` to sync `terminal.options.fontSize` + `fitAddon.fit()` when the setting changes.

Similarly, all components **MUST** respect the active theme (light/dark). Use CSS variables from the theme (e.g., `hsl(var(--foreground))`, `bg-card`, `text-muted-foreground`) — never hardcode color values like `#1b1b1b` or `rgb(255,255,255)`.

## OpenWiki

Structured documentation for this repository lives in [openwiki/quickstart.md](openwiki/quickstart.md):
repository overview, architecture, agent-execution flow, pipelines/automation, thread & worktree
domain rules, integrations/standalone services, operations/auth, and the development workflow.
Consult it when searching for context about how this codebase works.
