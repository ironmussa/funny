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

- **`packages/shared`** — Cross-package kernel. Hosts (a) types and error definitions (`src/types.ts`, `src/types/*.ts`, `src/errors.ts`, `src/models.ts`), (b) the shared DB layer used by `server` + `scheduler` (`src/db/schema.ts`, `src/db/schema.{sqlite,pg}.ts`, `src/db/adapters/{sqlite,pg}.ts`, `src/db/migrate.ts`, `src/db/connection.ts`), (c) factory-pattern repositories (`src/repositories/*.ts` — `createMessageRepository(db)`, `createThreadRepository(db)`, etc.) consumed by server + scheduler with a caller-supplied DB connection, (d) the runner↔server protocol (`src/runner-protocol.ts`), (e) auth signing helpers (`src/auth/forwarded-identity.ts`), (f) the thread state machine (`src/thread-machine.ts`), and (g) HTTP contracts (`src/contracts/*.ts`, see Key Patterns). `runtime` does NOT import the repositories — it proxies all persistence to the server via `RuntimeServiceProvider` (see Server Architecture). `client` imports types and browser-safe modules (contracts, zod schemas, `async`) through subpath exports, never the DB layer or repositories.
- **`packages/core`** — Pure logic shared across server and runtime. Contains git operations (`git/`), agent process management (`agents/`), and port allocation (`ports/`). No HTTP or database code.
- **`packages/runtime`** — Hono HTTP routes and services for agent execution. Manages agent runners, PTY sessions, worktrees, pipelines, and WebSocket broadcasting. Acts as the "runner" in the server+runner architecture.
- **`packages/server`** — Entry point for the application. Handles authentication (Better Auth), database (Drizzle + SQLite/PostgreSQL), user management, and proxies requests to remote runners. Owns all persistent state.
- **`packages/client`** — React 19 + Vite SPA. Runs on port 5173 with a proxy to the server at `/api`.

### Server Architecture

**Entry point:** `packages/server/src/index.ts` starts the Bun host (`src/hosts/bun/main.ts`): validates secrets, initializes the database and auth, starts Socket.IO, the runner transport and background jobs, and listens with `Bun.serve()`. The HTTP composition (middleware, routes, runner proxy) is host-independent in `src/app.ts` (`createServerApp`); host-specific assets (client bundle, extensions) are mounted by `hosts/bun/assets.ts`. Server secrets go through `src/lib/server-secrets.ts`. All agent/filesystem/git operations are proxied to remote runners connected over gRPC (see Deployment Architecture).

**Database:** SQLite via `bun:sqlite` (Bun's native SQLite driver) + Drizzle ORM. DB file lives at `~/.funny/data.db`. Tables are auto-created on startup via `db/migrate.ts` (raw SQL, not Drizzle migrations). Schema in `db/schema.ts` defines: `projects`, `threads`, `messages`, `tool_calls`.

**Key services (runtime):**

- `agent-runner.ts` — Spawns agent processes via `packages/core/src/agents/`. Persists messages/tool_calls and emits WebSocket events via `ws-broker`. Supports session resumption.
- `ws-broker.ts` — Singleton pub/sub that broadcasts WebSocket events to all connected clients. Single multiplexed stream (not per-thread).
- `pipeline-manager.ts` — Manages multi-step agent pipelines.
- `pty-manager.ts` — Terminal/PTY session management with multiple backends (headless-xterm, bun-native, node-pty).

**Key services (server):**

- `project-manager.ts` — CRUD for projects. Validates that the path is a git repo before creating.
- `runner-manager.ts` — Manages remote runner instances (registration, heartbeat, project assignments).
- `project-repository.ts`, `thread-event-repository.ts`, etc. — Database repositories for persistent state.
- `automation-scheduler.ts` — Owns the automation cron; each run starts a read-only thread on the automation owner's runner via `runner-thread-launcher.ts` (`startThreadOnRunner`, which delegates to the `modules/threads` creation use case — the same code as `POST /api/threads`). Runs complete in `automation-runs.ts` from the persisted terminal thread status. Assumes a single server instance.

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
- `/socket.io/` — Browser realtime endpoint (Socket.IO, multiplexed for all threads; `services/socketio/`)
- `/api/runner-grpc/ws` — WebSocket carrier for the runner gRPC connection (`RUNNER_GRPC_WS_PATH`)
- `/api/browse` — Filesystem browsing (drive roots, directory listing, repo name detection, git init)

### Client Architecture

**State management:** server-backed entity state lives in the **data layer** (`src/data/`, TanStack DB collections plus a shared query-core `QueryClient`). Zustand stores (`stores/project-store.ts`, `stores/thread-store.ts`, `stores/ui-store.ts`, …) hold UI state and the loaded thread payload (messages, tool calls) only. `stores/app-store.ts` remains as a backward-compatible facade for legacy callers.

**Data layer (`packages/client/src/data/`).** One `DataLayer` per session (`data/runtime.ts`), recreated when the user or active organization changes, so a logout drops every collection and cached request in one step. Each entity has its own folder (`threads/`, `projects/`, `templates/`, `git-status/`, `automations/`, `comments/`, `background/` (jobs + watchers), `scheduler/`, `approvals/`, `runner/`, `pull-requests/`, `profile/`, `queue/`, `context-usage/`):

- **Collections** hold rows with per-row writes (threads, projects, templates, git status, follow-up queues, context usage, …). **Queries** on the shared `QueryClient` hold request-shaped data without per-row writes (runner providers, ACP models, branch listings in `projects/branches.ts` (also the source of a project's current branch: `useProjectCurrentBranch` / `readProjectCurrentBranch`), PR detail and review threads, the user profile in `profile/`). Freshness (`staleTime`) and in-flight de-duplication replace the old per-store cooldown and `loading` maps. Do not add a `lastFetch` / cooldown map to a store.
- **Reads:** components import only from `data/*/hooks.ts` (live queries; unchanged rows and lists keep their references). Non-React code reads through `data/*/read.ts`. Only `hooks.ts` files may import React; the rest of `src/data/` stays renderer-independent.
- **Writes:** user actions go through `data/*/actions.ts`: optimistic transactions that show at once and roll back with a toast on failure (`data/optimistic-write.ts`). Server responses and realtime events become synced writes through the entity's loaders / `apply*Event` functions. A confirmed write **fences** the fields it changed (`data/threads/merge.ts`), so an older in-flight response cannot revert them. Writes the UI waits on anyway (queue edits, profile saves) skip the optimistic step and record the server's confirmed response.
- **No browser globals:** `src/data/` must not use `localStorage`, `window` or other DOM globals (`fitness:layering`, which also matches comments). Persistence belongs at the `stores/` boundary: e.g. the WS handlers save the context-usage row the collection wrote, and `selectThread` restores it with `restoreContextUsage()`.
- **Resync:** on reconnect, `data/resync.ts` invalidates every query and refetches the ones with a mounted reader.
- **Tests and stories** seed through the entity's `testing.ts` where one exists (`seedProjects`, `withProjects`, …) or `seedPR`, and reset with `replaceDataLayer(createDataLayer(...))`.
- **Guardrail:** `scripts/fitness/check-client-data-layer.ts` (in `bun run lint`) fails on collection writes outside `src/data/**` (the one shim is `stores/thread-row-writes.ts`), and on reintroducing the removed Zustand thread index (`threadsById`, the bucket arrays) or its helpers.

**Thread rows.** Every thread row lives once, in the threads collection (`data/threads/store.ts`). List membership and order per project, scratch and shared bucket are list metadata (`data/threads/list-meta.ts`), not copies of rows. Read rows with the hooks re-exported from [`lib/thread-selectors.ts`](packages/client/src/lib/thread-selectors.ts) (`useThreadById`, `useThreadsForProject`, `useScratchThreads`, `useSharedThreads`, `useThreadsByProject`). Read the open thread's changing fields (status, title, branch) through `stores/thread-view.ts` or the `stores/thread-context` hooks, not off the loaded payload, which is a load-time snapshot. Realtime row patches (status, `lastAssistantMessage`, cost, stage) go through `patchThreadRow` in `stores/thread-row-writes.ts`. `stores/thread-mutations.ts` only patches the loaded payload map (`threadDataById`) and its `activeThread` mirror.

**Real-time updates:** `hooks/use-ws.ts` connects to the server with `socket.io-client` and dispatches realtime events to the store (agent:message, agent:status, agent:result, agent:tool_call).

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
- **Sidebar storage.** Scratch and project threads are rows in the same threads collection; only their list metadata (`data/threads/list-meta.ts`) puts them in the scratch or project bucket. WS handlers that update sidebar-visible fields go through `patchSidebarThread(threadId, updater)` in `thread-ws-handlers.ts`, which writes the row through `patchThreadRow` (`stores/thread-row-writes.ts`). Never write the threads collection outside `src/data/` and that shim.
- **Routing.** Compose: `/scratch/new` (triggered by `startNewScratchThread()` in `ui-store.ts`). Detail: `/scratch/:threadId`. Use `getThreadRoute(thread)` from `thread-variant.ts` to build URLs — both scratch and normal routes are covered.
- **Compose-mode flag.** `ui-store.ts` exposes `newThreadIsScratch` + `startNewScratchThread()` / `cancelNewThread()` for the new-thread input branch. `ThreadView` reads this flag to render the scratch compose UI (no `ProjectHeader`).
- **Git middleware.** `packages/runtime/src/routes/git.ts` returns `400 git-not-allowed-for-scratch` for every git request against a scratch thread. The client's `canFetchGitStatus(thread)` is the matching predicate — both layers stay aligned.
- **v1 scope.** No per-project scratch entry point, no age-based cleanup, no "promote scratch → project", no team-shared scratch. Templates/automations are allowed at the type level but not surfaced in the v1 compose UI.

## Authentication

The app always uses [Better Auth](https://www.better-auth.com/) with cookie-based sessions. On first startup (only when no users exist yet), a default admin account is created automatically by `packages/server/src/lib/auth.ts`:

- **Username:** `admin` (override with `ADMIN_USERNAME`; email defaults to `admin@local.host`, override with `ADMIN_EMAIL`)
- **Password:** there is no static default. If `ADMIN_PASSWORD` is set and passes the password policy (`lib/password-policy.ts`: at least 10 characters with uppercase, lowercase and a digit), it is used. Otherwise a random password is generated and written to `<data dir>/admin-password.txt` (`~/.funny/admin-password.txt` by default, mode `0600`); only the file path is printed to stderr, never the password. A weak `ADMIN_PASSWORD` is rejected (audited) and falls back to a generated one. Delete the file after first login and change the password.

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
- **Runner** (`packages/runtime`) — Stateless process that executes agent work (spawning Claude CLI processes, managing git worktrees, PTY sessions). Runners dial out to the server over **gRPC** (`runner.v2` protocol; runtime `services/grpc-runner-client.ts`, server `services/grpc/`), so they can work behind NAT. The runner has **no database** — all data is proxied to the server via the gRPC data channel (`data:*` messages). Server → runner HTTP requests travel inside the same connection as gRPC `tunnel` frames.

The gRPC connection has two carriers:

- **Direct** — `RUNNER_GRPC_ENDPOINT` (e.g. a private network address such as `server.railway.internal:50051`).
- **WebSocket carrier** (default when `RUNNER_GRPC_ENDPOINT` is unset) — the runner derives `wss://<TEAM_SERVER_URL host>/api/runner-grpc/ws` and pipes gRPC bytes through it (`runtime services/grpc-websocket-bridge.ts`, `server services/grpc/websocket-carrier.ts`). The carrier only moves bytes; the protocol and per-stream authentication stay in gRPC. It does authenticate the upgrade itself: the runner sends its token as `Authorization: Bearer`, and a bad token gets 401. Runners from before that check send no token; they get a separate pool (64 sockets, 4 per address, closed if silent for 10 s) so they cannot crowd out authenticated runners. Set `RUNNER_GRPC_WS_ALLOW_UNAUTHENTICATED=false` to refuse them once every runner is updated.

Data flow: `Browser ⇄ Server` over Socket.IO; `Server ⇄ Runner` over gRPC (direct or WebSocket carrier).

**Deploying to Railway (production):** the prod stack runs on Railway as two services (`funny-server`, `funny-runner`) plus Postgres. See [docs/guides/railway-deploy.md](docs/guides/railway-deploy.md) for the connect + deploy runbook — how to load the project token (`source` `.env.railway-token.local`, never `cat` it), `railway up --service …`, verifying builds, and the rule that a new Claude model needs **both** a server deploy (model registry) and a runner deploy (bundled Claude Code CLI version).

Configuration:

- `TEAM_SERVER_URL` — **Required** on the runner to connect it to the server
- `RUNNER_AUTH_SECRET` — **Required** shared secret for runner ↔ server authentication
- `DATABASE_URL` — Optional PostgreSQL connection string on the server (default: SQLite at `~/.funny/data.db`)

> **Runners are not sandboxed.** A runner pointed at a remote `TEAM_SERVER_URL` effectively grants that server shell execution in the runner's `$HOME` (git ops, pre-commit hooks, Claude CLI spawn, PTY shells, access to saved GitHub tokens / provider keys). Only connect runners to central servers you trust, and prefer running each runner under a dedicated OS user / VM / container. See the **Machine B — Runner** section in [INSTALL.md](./INSTALL.md) for the full trust-boundary notes.

### Per-User Git Identity

Each user can configure their own git identity and GitHub credentials from **Settings > Profile**:

- **Git Name / Email** — Used as `--author` on commits and merges
- **GitHub Personal Access Token** — Used as `GH_TOKEN` for push and PR operations

Tokens are encrypted at rest using **AES-256-GCM** with a rotatable keyring (`packages/shared/src/lib/crypto.ts`). The keyring is auto-generated on first use and stored at:

```
~/.funny/encryption.keys.json   # plus the legacy ~/.funny/encryption.key, still read as keyId "legacy"
```

On the server, `FUNNY_ENCRYPTION_KEYS` (JSON: `{"active":"k1","keys":{"k1":"<hex-64>"}}`) replaces those files and is read-only — useful when the data dir is not persistent. It must contain every key that encrypted existing rows. The source is chosen in `packages/server/src/lib/server-secrets.ts`.

> **Important:** If the keyring is lost, any previously saved GitHub tokens become unrecoverable. Back it up if needed. The files are created with restricted permissions (`0600`) and refused if readable by others.

### GitHub access in sandbox threads (GitHub App)

A sandbox never receives the owner's PAT: anything in a sandbox can be read by the agent, a steer sharee or a prompt injection. The data channel refuses GitHub secrets to sandbox runners (`touchesGithubSecret` in `server/services/data-scope.ts`). Instead the server holds the deployment's **GitHub App** and mints, per sandbox thread, an installation token restricted to the thread's repository, valid for an hour, with permissions capped by the owner's own access (checked with the owner's PAT on the server). See `server/services/github-app/` (`token-issuer.ts`, `sandbox-tokens.ts`) and `runtime/services/sandbox-github-auth.ts`, which writes it to gh's `hosts.yml`, points git at `gh auth git-credential` and renews it every 45 minutes. Only the thread's own sandbox runner can ask (`data:get_github_app_token`, `SANDBOX_ONLY_TYPES`).

- **One App per deployment** (its key mints tokens for every installed repository, so it cannot be shared). An admin connects it in **Preferences > GitHub App** (GitHub's manifest flow; the key is stored encrypted in `instance_settings`) or sets `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, which win. Install it on **selected repositories** only.
- No App, not installed, or no owner access: no token, and the thread shows a `sandbox:error` card (phase `github`) saying what to do.
- A steer sharee can act on the repository through a sandbox agent without the owner's approval (the share dialog says so). Protect important branches with GitHub rulesets.

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

**The ONE intentional exception — steer-share delegation** (`thread-sharing-steer`). A thread shared at level `steer` lets a non-owner sharee send follow-ups (`POST /:id/message`) and read git (`status`/`diff`/`log`) on the OWNER's runner. This deliberately crosses the isolation boundary, and is allowed ONLY because every condition holds: (1) the route is on a fixed **allow-list** — a steer sharee reaches nothing else (no stop/approve/upload/rewind/convert/fork/tool-calls, no git write, never the owner's GitHub token); (2) the crossing happens in `middleware/proxy.ts` ONLY after `requireThreadSteer` has loaded + authorized the thread, then certifies a runner FOR THE OWNER (`RunnerFor<Owner, R>` via `withRunnerFor`, never a blind fallback) and sends through `AuthorizedRunnerRequests.sendDelegated` — the one method that signs a different identity (the sharee, with the `steer` claim) than the proof's actor, and the fitness check allows it only from `middleware/proxy.ts`; (3) every crossing emits the `share.steer_delegation` audit record; (4) the runtime re-authorizes via a **signed** `shareLevel`/`onBehalfOfThread` claim in the forwarded identity (it has no DB to look up the grant). Do NOT widen this allow-list or relax any of those four conditions without revisiting the change's design.md.

**Runner-request isolation proofs (`runner-request-isolation`).** The two rules above are enforced at the SINK, as compile-time obligations (gdp-ts), in `packages/server/src/services/runner-access/`. Every server → runner request or terminal message goes through `AuthorizedRunnerRequests.send` / `AuthorizedRunnerTerminal.dispatch|listSessions`, which demand a `RunnerFor<A, R>` proof that runner `R` is owned by actor `A` and in scope for the target. The ONLY prover is `runner-for.ts` (`withRunnerFor(actor, target, presence, (actor, runner, proof) => …)`): it lets the resolver CHOOSE the runner, then independently re-verifies ownership (`runners.user_id`, or presence) and scope (`runner-scope`) and refuses + audits anything else. The sink SIGNS the forwarded identity itself from the certified actor (fresh nonce per send) and drops any identity header a caller supplied — callers never build `X-Forwarded-*` headers. Names and proofs cannot leave the callback, so a proof is bound to one actor, one runner, one operation. `userId` is REQUIRED in `findRunnerForProject` / `resolveRunner` / `resolveRunnerDetailed`; the single userless path is the unauthenticated MCP OAuth callback, which uses the weaker `OAuthCallbackRunner<R>` proof that only `sendOAuthCallback` accepts and that signs no identity. Its prover (`withOAuthCallbackRunner(state, …)`) routes ONLY to the runner a server-signed `state` is bound to — minted by the proxy with `mintOAuthCallbackState(actor, runner, RunnerFor proof)` when it forwards the owner's `POST /api/mcp/oauth/start` — and re-verifies that runner's owner and presence; there is no "any runner" fallback. The server renders the callback page itself, and the proxy neutralizes every runner response whose content type is not a passive one (JSON, text, media, PDF): HTML/JS/XML become `text/plain` + `attachment` + `CSP: sandbox`, SVG keeps its type but is sandboxed. System callers (scheduler `/dispatch` + `/cancel`, project-runner-settings stop-sessions) derive the actor from the THREAD or PROJECT OWNER in the DB, never from the request body; a mismatching `userId` is refused and audited. `scripts/fitness/check-runner-request-sinks.ts` (in `bun run lint`) fails on any raw `.request(` / `.dispatch(` / `.listSessions(` outside `services/runner-access/` and `services/grpc/`, on `sendDelegated` outside `middleware/proxy.ts`, and on `createRunnerAccess` (test-only DI) outside `services/runner-access/`; `bun run lint:proofs` and `bun run typecheck:proofs` (`type-tests/runner-isolation.ts`) guard forging, minting outside the prover, and proof/name escapes. Do NOT add a sink, widen the OAuth proof, or re-derive ownership/scope at a call site.

**Project ↔ runner binding (`project-runner-binding`).** Inside one user's runners there is a second boundary: a runner has a role — `general` (serves projectless work: scratch, browse, add-local-project, and every project without an override) or `dedicated` (serves ONLY the projects pinned to it or explicitly granted). A project pinned to a dedicated runner (`project_runner_settings.dedicated_runner_id`) routes ONLY to that runner + explicit grants (`project_runner_grants`); if they are offline the request fails with `project-runner-offline` — never a fallback. `runner_project_assignments` is a LOCATION record that runners write themselves; it is never an authorization source. The rule lives in ONE place — `packages/server/src/services/runner-scope.ts` (`canRunnerAccessProject`, `canRunnerServeProjectless`) — and is enforced in three layers: routing (`runner-resolver.ts`, `runner-manager.findRunnerForProject`), the runner→server data channel (`data-scope.ts`, every `data:*` type MUST have a rule in `DATA_SCOPE_RULES`; unknown types are refused), and agent events (`grpc/events-handler.ts`). Never re-derive the rule at a call site. Its caches are versioned: every scope write (role, general runner, dedicated runner, grants, sandbox binding, runner deletion) goes through the writers in `runner-scope.ts` / `runner-manager.ts`, which bump `runner_policy_version`; every read syncs that version first, so a revocation applies on all server instances at once. Never write `runners.role`, `project_runner_settings`, `project_runner_grants` or delete runners without going through them.

**Thread execution location (`thread-context`).** A request made from a thread's view runs where that thread runs: a sandbox thread on its own sandbox runner (never a fallback to the local runner), any other thread on its project's runner. The rule lives in ONE place on each side. Server: `runner-resolver.ts` takes the thread from a thread route (`/api/threads/:id`, `/api/git/:threadId`) or from the client's thread context (`?threadId=`, or the `X-Funny-Thread-Id` header that `middleware/proxy.ts` folds into the routing query); a context thread only steers requests about its own project (or no project). Client: API functions about the open thread's workspace (files, search, symbols, skills, raw-file URLs) use `requestInThread` / `urlInThread` / `threadContextHeaders` from `lib/api/_core.ts`, whose open thread comes from `lib/thread-context-source.ts`. Terminals carry `sandboxThreadId` on spawn (`services/socketio/terminal-targets.ts`). Host-only affordances (open in editor / open directory) are gated by `canOpenOnHost(thread)` in `thread-variant.ts`. Do NOT pick a runner by project for thread-view data, or branch on `runtime === 'sandbox'` at a call site — add a predicate or route through the thread context instead.

- Thread modes: `local` runs the agent in the project directory; `worktree` creates a git worktree with an isolated branch
- All git operations use async functions from `packages/core/src/git/` — use `gitRead`/`gitWrite` for git commands and `execute` for general process execution from `git/process.ts`
- The agent runner spawns agent processes via `packages/core/src/agents/` and stores a session ID for resuming conversations
- WebSocket events carry a `threadId` field so the client can associate updates with the correct thread
- The model selector maps friendly names (sonnet/opus/haiku) to full model IDs in `agent-runner.ts`

### Asynchronous orchestration with Effect

Prefer Effect for cancellation, retry waits, timeouts, bounded concurrency, and
resource lifetimes, following `AGENTS.md`. Preserve `neverthrow` domain results and
public service contracts; use explicit adapters at async boundaries. Simple pure
functions and UI rendering do not need Effect wrappers.

### HTTP contracts (`@funny/shared/contracts/*`)

A route group with a contract declares each endpoint once in `packages/shared/src/contracts/<group>.ts`: method, path (relative to the router mount), zod schemas for query and body, and the response type (`endpointGroup('/automations').endpoint<Automation>()({ method: 'GET', path: '/:id' })`). Both sides use that object:

- **Server:** register with `serveEndpoint(router, endpoint, handler)` from `packages/server/src/validation/endpoint.ts`. It takes the method and path from the endpoint, refuses 401 without a user, runs `options.middleware` (e.g. `requireThreadOwner`, so a missing resource answers 404 before a bad body answers 400), validates query and body (400 `{ error }`), and requires the handler to return `reply(body)` / `fail(status, error)` with the declared response type. Map DB rows to the contract type in the route (integers to booleans, `null` to absent); never return a raw drizzle row.
- **Client:** call with `callEndpoint(endpoint, { params, query, body })` from `packages/client/src/lib/api/_contract.ts`. It goes through `request()`, so auth, telemetry and the circuit breaker still apply.
- **Request types** come from the schemas (`z.input<typeof schema>`), not from a separate interface, so they cannot claim fields the server does not accept.

`/api/automations`, the pipeline CRUD and run history (`lib/pipeline-response.ts`), and the server-answered `/api/threads` routes (lists, detail, field updates; `lib/thread-response.ts` maps the rows) are on contracts. Thread creation, fork and the runner-proxied thread routes are not: their responses come from the runner. The rest still use `request<T>(path)`, whose `T` is unchecked. Move a group over when you touch it. Hono RPC (`hono/client`) was rejected because importing the server's route types pulls Bun-only modules into the client typecheck.

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

## Formatting

Format with **oxfmt** (`bun run format`, or `bunx oxfmt --write <files>`), never prettier — the repo has no prettier config, so prettier silently rewrites files to its own defaults. The pre-commit hook re-formats staged files with oxfmt.

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

<!-- fallow:agent-install v1 claude-import:start -->

@AGENTS.md
<!-- fallow:agent-install v1 claude-import:end -->
