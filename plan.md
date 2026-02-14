# Migration Plan: TypeScript Server → Rust (Axum)

## Overview

Migrate `packages/server` from TypeScript/Hono/Bun to Rust/Axum/Tokio by forking the `temp_vibe_kanban` architecture into `packages/server-rs/`. The React client stays as-is — only the HTTP+WebSocket server is rewritten.

## Architecture

Fork temp_vibe_kanban's Rust workspace structure, adapted for a-parallel's domain:

```
packages/server-rs/
├── Cargo.toml              # workspace root
├── crates/
│   ├── api-types/          # Shared types (serde + ts-rs for TS generation)
│   ├── db/                 # SQLx + SQLite models & migrations
│   ├── server/             # Axum HTTP server + WebSocket + routes
│   ├── services/           # Business logic (agent-runner, worktree, etc.)
│   ├── executor/           # Claude CLI process management
│   ├── git/                # Git operations (git2 + CLI fallback)
│   └── utils/              # Cross-cutting: ws-broker, process helpers, auth
```

## Phase 1: Scaffold & Core Infrastructure

### 1.1 — Workspace Setup
- Create `packages/server-rs/Cargo.toml` workspace with all crate members
- Copy dependency patterns from temp_vibe_kanban (Axum 0.8, SQLx 0.8, Tokio 1, etc.)
- Set up `rust-toolchain.toml` with stable channel

### 1.2 — API Types Crate (`crates/api-types`)
- Port all types from `packages/shared/src/types.ts`:
  - `Project`, `Thread`, `Message`, `ToolCall`, `ThreadWithMessages`
  - `Automation`, `AutomationRun`, `UserProfile`
  - Enums: `ThreadMode`, `ThreadStatus`, `ThreadStage`, `ClaudeModel`, `PermissionMode`, `AuthMode`
  - WebSocket event types: `WSEvent` variants
  - Request/response types
- Derive `Serialize`, `Deserialize`, `TS` (ts-rs), `FromRow` where applicable
- Generate TypeScript bindings so the client can import them

### 1.3 — Database Crate (`crates/db`)
- Port schema from `packages/server/src/db/schema.ts` (10 tables):
  - `projects`, `threads`, `messages`, `tool_calls`, `startup_commands`
  - `automations`, `automation_runs`, `user_profiles`, `stage_history`, `mcp_oauth_tokens`
- Write SQLx migrations (proper `.sql` files, not ALTER TABLE hacks)
- Implement model structs with `FromRow` + query methods (`find_by_id`, `create`, `list`, etc.)
- Use `~/.a-parallel/data.db` (same path as current) for backwards compatibility
- Create/Update request types per model

### 1.4 — Utils Crate (`crates/utils`)
- `ws_broker.rs` — WebSocket pub/sub (port from `ws-broker.ts`)
  - `HashMap<WsId, (SplitSink, UserId)>` with broadcast + per-user emit
- `process.rs` — Async process execution helpers (tokio::process::Command)
- `auth.rs` — Token generation/validation, file-based auth token at `~/.a-parallel/auth-token`
- `path.rs` — Path validation, tilde expansion
- `claude_binary.rs` — Check Claude CLI availability in PATH

## Phase 2: Git & Executor

### 2.1 — Git Crate (`crates/git`)
- Port operations from `packages/server/src/utils/git-v2.ts`:
  - `get_current_branch`, `list_branches`, `get_status_summary`
  - `get_diff`, `stage_files`, `unstage_files`, `revert_files`
  - `commit`, `push`, `create_pr` (via `gh` CLI)
  - `derive_git_sync_state`
- Use `git2` crate for read operations (branches, status, diff)
- Fall back to CLI (`tokio::process::Command`) for write operations (commit, push, PR)
- Port worktree management from `worktree-manager.ts`:
  - `create_worktree`, `remove_worktree`, `list_worktrees`

### 2.2 — Executor Crate (`crates/executor`)
- Port `claude-process.ts` → `claude_process.rs`:
  - Spawn `claude --print --output-format stream-json` via `tokio::process::Command`
  - Parse NDJSON stdout stream into typed `CLIMessage` events
  - Handle stdin writing for follow-up messages and tool responses
  - Session resumption via `--resume` flag
- Port `agent-runner.ts` → `agent_runner.rs`:
  - `AgentRunner` struct with `HashMap<ThreadId, RunningAgent>`
  - Message handler: parse CLI messages, persist to DB, emit WebSocket events
  - Track active agents, result status, manual stops
  - Permission mode mapping, model mapping
  - Handle `can_use_tool` requests for permission approval
- Port `merge-agent.ts` → `merge_agent.rs`

## Phase 3: Services Layer

### 3.1 — Services Crate (`crates/services`)
- `thread_manager.rs` — Port from `thread-manager.ts`:
  - CRUD for threads with DB persistence
  - In-memory cache for active thread state
  - Stage transitions with history tracking
  - Archive/unarchive, pin/unpin
- `project_manager.rs` — Port from `project-manager.ts`:
  - CRUD for projects with git repo validation
  - Sort order management
- `automation_manager.rs` — Port from `automation-manager.ts` + `automation-scheduler.ts`:
  - CRUD for automations
  - Cron scheduling via `tokio-cron-scheduler` or similar
  - Run management and history
- `pty_manager.rs` — Port from `pty-manager.ts`:
  - PTY spawn/write/resize/kill via `portable-pty` crate
  - Per-user PTY tracking
- `mcp_service.rs` — Port MCP server configuration
- `skills_service.rs` — Port skills/CLAUDE.md discovery
- `plugin_service.rs` — Port plugin management
- `profile_service.rs` — Port user profile + encrypted GitHub token storage
- `browse_service.rs` — Port filesystem browsing (drive roots, directory listing)
- `startup_commands.rs` — Port startup command management

## Phase 4: HTTP Server & Routes

### 4.1 — Server Crate (`crates/server`)
- `main.rs` — Entry point:
  - `#[tokio::main]` with tracing setup
  - Database initialization + migrations
  - Service construction
  - Router assembly
  - Graceful shutdown (SIGINT/SIGTERM)
- `router.rs` — Axum router assembly:
  - CORS middleware (tower-http)
  - Auth middleware (bearer token validation)
  - Rate limiting middleware
  - Static file serving (rust-embed for client dist)
  - SPA fallback
- Route modules (one per domain):
  - `routes/health.rs` — `GET /api/health`
  - `routes/auth.rs` — `GET /api/auth/mode`, token endpoints
  - `routes/projects.rs` — CRUD + branch listing + sort order
  - `routes/threads.rs` — CRUD + start/stop agent + send message + stage management
  - `routes/git.rs` — Diff, stage, unstage, revert, commit, push, PR
  - `routes/browse.rs` — Filesystem browsing
  - `routes/mcp.rs` — MCP server management
  - `routes/skills.rs` — Skills discovery
  - `routes/plugins.rs` — Plugin management
  - `routes/worktrees.rs` — Worktree management
  - `routes/automations.rs` — Automation CRUD + scheduling
  - `routes/profile.rs` — User profile management
  - `routes/github.rs` — GitHub repo listing, cloning
  - `routes/analytics.rs` — Analytics/metrics
  - `routes/ws.rs` — WebSocket upgrade + message handling (PTY, events)

### 4.2 — State & Middleware
- `AppState` struct holding all services:
  ```rust
  struct AppState {
      db: SqlitePool,
      agent_runner: Arc<AgentRunner>,
      ws_broker: Arc<WsBroker>,
      pty_manager: Arc<PtyManager>,
      // ... other services
  }
  ```
- Auth middleware: extract bearer token from `Authorization` header, validate
- Extension pattern for loaded entities (project, thread middleware loaders)

## Phase 5: WebSocket & Real-time

### 5.1 — WebSocket Handler
- Axum WebSocket upgrade at `/ws`
- Auth validation on upgrade (token from query param)
- Message dispatch:
  - `pty:spawn`, `pty:write`, `pty:resize`, `pty:kill` → PtyManager
  - Future: additional bidirectional events
- Outbound events via WsBroker:
  - `agent:message`, `agent:status`, `agent:result`, `agent:tool_call`
  - `agent:cost_update`, `agent:waiting`, `agent:git_sync`
  - Per-user filtering

## Phase 6: Integration & Testing

### 6.1 — Build Integration
- Update root `package.json` scripts:
  - `dev:server-rs` — `cargo watch -x run` in `packages/server-rs`
  - `build:server-rs` — `cargo build --release`
- Vite proxy config stays the same (port 3001)
- Client requires zero changes (same REST API + WebSocket protocol)

### 6.2 — Database Migration
- New SQLx migrations produce identical schema to current Drizzle setup
- Existing `~/.a-parallel/data.db` works without modification
- Add migration path for any schema differences

### 6.3 — Testing Strategy
- Unit tests per crate (model queries, git operations, process parsing)
- Integration tests for API routes (axum::test helpers)
- End-to-end: start Rust server, run client, verify agent lifecycle

## Phase 7: Multi-User Auth (Stretch)

- Port Better Auth integration or replace with custom JWT/session auth
- Cookie-based sessions for multi-user mode
- Admin user management
- Per-user data isolation (same `user_id` filtering pattern)

---

## Key Dependencies

| Crate | Purpose | Version |
|-------|---------|---------|
| axum | HTTP framework | 0.8 |
| tokio | Async runtime | 1.x |
| sqlx | Database (SQLite) | 0.8 |
| serde / serde_json | Serialization | 1.x |
| tower-http | Middleware (CORS, etc.) | 0.6 |
| git2 | Git operations | 0.20 |
| ts-rs | Rust → TypeScript types | 10.x |
| thiserror | Error types | 2.x |
| tracing | Structured logging | 0.1 |
| rust-embed | Embed client dist | 8.x |
| portable-pty | PTY management | 0.8 |
| nanoid | ID generation | 0.4 |
| chrono | Date/time | 0.4 |
| uuid | UUIDs | 1.x |

## Execution Order

1. **Phase 1** — Scaffold workspace, types, DB, utils (~foundation)
2. **Phase 2** — Git operations + Claude executor (~core engine)
3. **Phase 3** — Service layer (~business logic)
4. **Phase 4** — HTTP routes + middleware (~API surface)
5. **Phase 5** — WebSocket + real-time (~live features)
6. **Phase 6** — Integration, testing, build scripts
7. **Phase 7** — Multi-user auth (if needed)

Each phase produces a compilable, testable milestone. The client can switch to the Rust server at any point after Phase 4 is complete.
