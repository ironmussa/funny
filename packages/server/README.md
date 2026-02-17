# @funny/server

Hono HTTP server that orchestrates Claude Code agents, manages git worktrees, and streams real-time events over WebSocket.

## Quick Start

```bash
# From monorepo root
npm run dev:server

# Or directly
bun --watch src/index.ts
```

Server runs on **http://localhost:3001** by default.

## Architecture

```
src/
├── index.ts                  # Entry point — Hono app, middleware, routes, WebSocket
├── db/
│   ├── index.ts              # SQLite connection (Bun native driver + Drizzle ORM)
│   ├── schema.ts             # Table definitions (projects, threads, messages, etc.)
│   └── migrate.ts            # Auto-migration on startup (CREATE TABLE IF NOT EXISTS)
├── routes/
│   ├── projects.ts           # CRUD for projects + branch listing
│   ├── threads.ts            # CRUD + start/stop agents + send follow-up messages
│   ├── git.ts                # Diff, stage, unstage, commit, push, PR, merge
│   ├── automations.ts        # Scheduled agent tasks (CRUD + trigger + inbox)
│   ├── browse.ts             # Filesystem browsing (drive roots, directory listing)
│   ├── worktrees.ts          # Git worktree management
│   ├── mcp.ts                # MCP server configuration + OAuth flow
│   ├── skills.ts             # Skill management (install, remove, list)
│   ├── plugins.ts            # Plugin listing
│   ├── profile.ts            # Per-user git identity and GitHub token
│   └── auth.ts               # Local mode token endpoint
├── services/
│   ├── agent-runner.ts       # Spawns Claude CLI, parses NDJSON stream, persists results
│   ├── claude-process.ts     # Manages a single Claude CLI child process
│   ├── thread-manager.ts     # Thread CRUD + status management
│   ├── project-manager.ts    # Project CRUD + git validation
│   ├── worktree-manager.ts   # Git worktree creation/removal
│   ├── ws-broker.ts          # WebSocket pub/sub (multiplexed, per-user filtered)
│   ├── automation-manager.ts # Automation CRUD + run tracking
│   ├── automation-scheduler.ts # Cron-based automation execution
│   ├── command-runner.ts     # Startup command process management
│   ├── profile-service.ts    # User profile CRUD (git identity, encrypted GitHub token)
│   └── auth-service.ts       # Local mode bearer token generation
├── utils/
│   ├── git-v2.ts             # Git operations (async, array-based, neverthrow)
│   ├── process.ts            # Process execution (Bun.spawn wrapper)
│   ├── path-validation.ts    # Path sanitization and traversal prevention
│   ├── route-helpers.ts      # Shared route extraction helpers
│   └── result-response.ts    # neverthrow Result -> Hono Response mapper
├── middleware/
│   ├── auth.ts               # Dual-mode auth (bearer token / session cookie)
│   ├── error-handler.ts      # Global error handler
│   └── rate-limit.ts         # Simple in-memory rate limiter
├── lib/
│   ├── auth-mode.ts          # Reads AUTH_MODE env var
│   ├── auth.ts               # Better Auth instance (multi mode only)
│   └── crypto.ts             # AES-256-GCM encryption for secrets at rest
└── validation/
    └── schemas.ts            # Zod schemas for request validation
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/auth/mode` | Get auth mode (local/multi) |
| `GET/POST` | `/api/projects` | List / create projects |
| `GET/POST` | `/api/threads` | List / create threads |
| `POST` | `/api/threads/:id/message` | Send follow-up message to agent |
| `POST` | `/api/threads/:id/stop` | Stop a running agent |
| `GET` | `/api/git/:threadId/diff` | Get file diffs |
| `POST` | `/api/git/:threadId/stage` | Stage files |
| `POST` | `/api/git/:threadId/commit` | Commit staged changes |
| `POST` | `/api/git/:threadId/push` | Push to remote |
| `POST` | `/api/git/:threadId/pr` | Create pull request (via gh CLI) |
| `POST` | `/api/git/:threadId/merge` | Merge branch into target |
| `GET/PUT` | `/api/profile` | Get/update user git identity |
| `GET/POST` | `/api/automations` | List / create automations |
| `WS` | `/ws` | Real-time event stream |

## Key Design Decisions

- **Claude CLI as subprocess** — Agents are spawned via `claude --print --output-format stream-json`, not direct API calls. This gives us session resumption, tool access, and MCP integration for free.
- **neverthrow everywhere** — All service and utility functions return `Result` or `ResultAsync` types. No thrown exceptions in business logic.
- **Git worktrees for isolation** — Each agent works in a `.funny-worktrees/` directory next to the project. Full filesystem isolation, shared git history.
- **SQLite for simplicity** — Single-file database at `~/.funny/data.db` with WAL mode for concurrent reads. No external database to set up.
- **Dual auth mode** — `AUTH_MODE=local` (single user, bearer token) or `AUTH_MODE=multi` (Better Auth with sessions, per-user isolation).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `CLIENT_PORT` | `5173` | Client port (for CORS) |
| `AUTH_MODE` | `local` | Authentication mode (`local` or `multi`) |

## Tech Stack

- **Runtime:** [Bun](https://bun.sh/)
- **Framework:** [Hono](https://hono.dev/)
- **Database:** SQLite (Bun native) + [Drizzle ORM](https://orm.drizzle.team/)
- **Auth:** [Better Auth](https://www.better-auth.com/) (multi mode)
- **Validation:** [Zod](https://zod.dev/)
- **Error handling:** [neverthrow](https://github.com/supermacro/neverthrow)
