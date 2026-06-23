# funny

> Parallel Claude Code agent orchestration powered by git worktrees

funny is a web UI for orchestrating multiple [Claude Code](https://claude.ai/code) agents in parallel. It uses git worktrees to let each agent work on its own branch simultaneously without conflicts. Think of it as a Codex App clone powered by the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (`@anthropic-ai/claude-agent-sdk`).

## Features

- **Parallel agent execution** — Run multiple Claude Code agents simultaneously on different branches
- **Git worktree isolation** — Each agent gets its own isolated working directory
- **Real-time monitoring** — WebSocket-based live updates for all agent activities
- **Git integration** — Built-in diff viewer, staging, commits, and PR creation
- **Kanban board** — Drag-and-drop task management with columns (backlog, in progress, review, done, archived)
- **Search** — Find threads by title, branch name, status, or message content with real-time filtering
- **Analytics dashboard** — Track task creation, completion rates, stage distribution, and cost metrics over time
- **Agent providers** — Drive Codex, Gemini, Cursor, opencode and other ACP agents alongside Claude; trim or extend the set from Settings → Providers
- **MCP support** — Model Context Protocol integration
- **Automation scheduling** — Cron-based recurring tasks
- **Mobile support** — Responsive mobile view with touch-friendly navigation for on-the-go monitoring

## Installation

### Quick Start (bunx)

No installation needed! Run directly with:

```bash
bunx @ironmussa/funny@latest
```

The app will start and open at `http://localhost:3001`

### Global Installation

```bash
bun install -g @ironmussa/funny
funny
```

### From Source

```bash
git clone https://github.com/ironmussa/funny.git
cd funny
bun install
bun run build
bun start
```

## Requirements

- **Bun** >= 1.0.0 (install from [bun.sh](https://bun.sh))
- **Claude CLI** installed and authenticated ([claude.ai/code](https://claude.ai/code))
- **Git** installed and configured

## Usage

funny has two modes: **local** (solo, everything on your machine) and **team** (multiple users collaborating via a central server).

### Local Mode (Single User)

This is the default. Everything runs on your machine — UI, database, git operations, and Claude agents.

```bash
# Quick start (no installation)
bunx @ironmussa/funny@latest

# Or if installed globally
funny

# Custom port
funny --port 8080

# Show all options
funny --help
```

Open `http://localhost:3001` in your browser.

On first startup, funny creates a local admin account:

- **Username:** `admin`
- **Password:** generated automatically and written to `~/.funny/admin-password.txt`

The credentials file is created with mode `0600`. Delete it after first login and change the password. To choose the initial password yourself, set `ADMIN_PASSWORD` before the first startup; it must be at least 10 characters and include uppercase, lowercase, and numeric characters.

### Team Mode (Multiple Users)

Team mode lets multiple users collaborate on shared projects. It requires two components:

1. **Central server** (`funny-server`) — Runs on a shared machine. Manages users, projects, memberships, and coordinates runners.
2. **Local runner** (`funny --team <url>`) — Each team member runs a runner that connects to the central server.

#### Step 1: Start the central server

On a shared machine (or your own machine if your team is on the same network):

```bash
# Install
bun install -g @ironmussa/funny

# Start the central server
funny-server --port 3002
```

On first start, a default admin account is created:

- **Username:** `admin`
- **Password:** generated automatically and written to the server data directory (`~/.funny/admin-password.txt` by default)

The credentials file is created with mode `0600`. Delete it after first login and change the password. To choose the initial password yourself, set `ADMIN_PASSWORD` before the first startup; it must be at least 10 characters and include uppercase, lowercase, and numeric characters. The admin can create additional user accounts from the central server's API.

#### Step 2: Each team member connects

Each team member runs funny locally with the `--team` flag:

```bash
funny --team http://<central-server-ip>:3002
```

The runner prints a short device-link code. In the central server UI, open **Settings > Runners**, click **Link a runner**, enter the code, and approve it. A plain `funny` or `bunx @ironmussa/funny@latest` always starts local by default; every team run should pass `--team <url>` explicitly.

This starts a runner-only process. The UI, auth, projects, and thread state live on the central server; the runner connects back to:

- Receive dispatched tasks from the central server
- Run git operations and Claude agents on the member's machine
- Stream terminal/browser/agent events back to the central server

Each member's git operations and Claude agents run **on their own machine**, in their own local repos. The central server only coordinates — it never touches your filesystem.

#### Team mode architecture

```
Team member A                    Team member B
┌──────────────────┐            ┌──────────────────┐
│ funny --team URL │            │ funny --team URL │
│ ┌──────────────┐ │            │ ┌──────────────┐ │
│ │ Local git    │ │            │ │ Local git    │ │
│ │ Local agents │ │            │ │ Local agents │ │
│ └──────┬───────┘ │            │ └──────┬───────┘ │
└────────┼─────────┘            └────────┼─────────┘
         │         ┌──────────┐          │
         └────────►│ Central  │◄─────────┘
                   │ Server   │
                   │ (users,  │
                   │ projects,│
                   │ teams)   │
                   └──────────┘
```

### CLI Options

**funny** (local app)

| Option               | Description                               | Default     |
| -------------------- | ----------------------------------------- | ----------- |
| `-p, --port <port>`  | Server port                               | `3001`      |
| `-h, --host <host>`  | Server host                               | `127.0.0.1` |
| `--auth-mode <mode>` | Authentication mode: `local` or `multi`   | `local`     |
| `--team <url>`       | Connect this machine as a runner to a central server | -           |
| `--token <token>`    | Runner invite token for team registration | -           |
| `--local`            | Start standalone; cannot combine with `--team` | `false` |
| `--help`             | Show help message                         | -           |

**funny-server** (team coordination server)

| Option              | Description       | Default   |
| ------------------- | ----------------- | --------- |
| `-p, --port <port>` | Server port       | `3002`    |
| `-h, --host <host>` | Server host       | `0.0.0.0` |
| `--help`            | Show help message | -         |

### Persistent Configuration

Saved values in `~/.funny/.env` do not activate team mode. A plain `funny` or `bunx @ironmussa/funny@latest` always starts in local mode by default. To connect to a central server, pass `--team <url>` explicitly.

```bash
# Local standalone
funny

# Team runner
funny --team http://192.168.1.10:3002
```

**Precedence order:** CLI flags > shell environment variables > saved non-team values in `~/.funny/.env`. Team mode requires `--team <url>`.

To change the server, pass `--team` with the new URL.

### Environment Variables

| Variable                 | Description                             | Default            | Used by      |
| ------------------------ | --------------------------------------- | ------------------ | ------------ |
| `PORT`                   | Server port                             | `3001` / `3002`    | both         |
| `HOST`                   | Server hostname                         | `127.0.0.1`        | both         |
| `AUTH_MODE`              | Authentication mode (`local`/`multi`)   | `local`            | funny        |
| `ADMIN_USERNAME`         | Bootstrap admin username                | `admin`            | both         |
| `ADMIN_EMAIL`            | Bootstrap admin email                   | `admin@local.host` | both         |
| `ADMIN_PASSWORD`         | Bootstrap admin password; generated if unset | -             | both         |
| `RUNNER_INVITE_TOKEN`    | Runner invite token for `--team` classic flow | -             | funny        |
| `RUNNER_AUTH_SECRET`     | Shared secret for `--team` classic flow | -                  | funny        |
| `CORS_ORIGIN`            | Custom CORS origins (comma-separated)   | Auto-configured    | both         |
| `FUNNY_CENTRAL_DATA_DIR` | Central server data directory           | `~/.funny-central` | funny-server |
| `LOG_LEVEL`              | Log level (debug/info/warn/error)       | `info`             | funny-server |

## Orchestrator

The orchestrator is the scheduler that automatically claims eligible threads, dispatches them to the matching runner, and handles retries with exponential backoff. It runs in two loops:

- **Poll loop** — picks eligible candidates from the DB, sorts them by priority, and dispatches up to the global / per-user concurrency caps.
- **Reconcile loop** — reattaches in-flight runs after a restart, releases stalled claims, and clears retry entries that are past their backoff.

It runs as **its own process** — the `@funny/thread-orchestrator` binary — and talks to the server over HTTP via `/api/orchestrator/system/*`. This decouples its release cycle from the server, lets it scale or restart independently, and keeps the trust boundary explicit.

> **Migrating from in-process mode?** Earlier versions hosted the orchestrator inside the server gated by `ORCHESTRATOR_ENABLED`. That mode is gone. The brain now must run as a separate process; `ORCHESTRATOR_ENABLED` on the server is no longer read.

### Setup

1. **On the server**, pick a shared secret (`openssl rand -hex 32`) and set it before starting:

   ```bash
   ORCHESTRATOR_AUTH_SECRET=<long-random-string>
   ```

   The server uses this to authenticate the brain's HTTP calls.

2. **On the orchestrator process**, set the same secret plus the server URL and run the binary:

   ```bash
   FUNNY_SERVER_URL=http://localhost:3001 \
   ORCHESTRATOR_AUTH_SECRET=<same-secret> \
   bun run --filter @funny/thread-orchestrator start
   ```

   Or equivalently from the workspace root:

   ```bash
   FUNNY_SERVER_URL=... ORCHESTRATOR_AUTH_SECRET=... bun packages/orchestrator/src/bin/orchestrator.ts
   ```

3. The brain auto-starts its loops and begins dispatching. Stop with `SIGTERM` / `SIGINT` for graceful shutdown.

> **Trust boundary.** The shared secret grants the orchestrator cross-tenant access to thread/run state across **all users** — only run it inside a network you trust (same host, private VPC) and treat the secret like a root credential. The server validates the secret and rejects calls without it.

### Configuration

All knobs are optional with sensible defaults — only override what you need. These all live on the orchestrator process (the server doesn't read them):

| Variable                      | Description                                                                                | Default        |
| ----------------------------- | ------------------------------------------------------------------------------------------ | -------------- |
| `FUNNY_SERVER_URL`            | **Required.** Base URL of the funny server.                                                | —              |
| `ORCHESTRATOR_AUTH_SECRET`    | **Required.** Must match the server's value.                                               | —              |
| `ORCHESTRATOR_POLL_MS`        | Poll loop interval (how often eligible threads are scanned).                               | `5000`         |
| `ORCHESTRATOR_RECONCILE_MS`   | Reconcile loop interval (stall detection, orphan recovery, backoff sweep).                 | `30000`        |
| `ORCHESTRATOR_MAX_GLOBAL`     | Maximum concurrent dispatched runs across all users.                                       | `16`           |
| `ORCHESTRATOR_MAX_PER_USER`   | Maximum concurrent dispatched runs per user (tenant fairness cap).                         | `4`            |
| `ORCHESTRATOR_MAX_BACKOFF_MS` | Cap for exponential retry backoff between failed attempts.                                 | `300000`       |
| `ORCHESTRATOR_STALL_MS`       | Time without an event before a claimed run is considered stalled.                          | `1800000`      |
| `ORCHESTRATOR_PIPELINE_NAME`  | Override the default pipeline name passed to the runner.                                   | runner default |
| `ORCHESTRATOR_LONG_POLL_MS`   | Long-poll timeout for the events stream (the brain reacts to terminal runs via this loop). | `25000`        |
| `ORCHESTRATOR_LOG_FORMAT`     | `text` (single-line, human-readable) or `json` (ndjson).                                   | `text`         |
| `ORCHESTRATOR_LOG_LEVEL`      | `debug` / `info` / `warn` / `error`.                                                       | `info`         |

### Operational notes

- **Runner isolation is preserved.** A user's threads only ever dispatch to that user's own runner. If the user's runner is offline, the orchestrator skips the candidate (it does not fall back to another user's runner).
- **Crash-safe.** In-flight dispatches are tracked in the `orchestrator_runs` table. After a restart the reconcile loop reattaches them so work isn't double-dispatched or silently dropped.
- **Don't run two brains.** Only one orchestrator process should be active at a time — multiple brains will race to claim the same threads.
- **Stop to debug.** Stopping the orchestrator process pauses new dispatches immediately; in-flight runs keep going on the runner side and are reconciled on next start.

## Kanban Board

Threads can be visualized and managed as a Kanban board with five columns:

- **Backlog** — Tasks waiting to be started
- **In Progress** — Tasks currently being worked on
- **Review** — Tasks ready for code review
- **Done** — Completed tasks
- **Archived** — Archived tasks

Drag and drop cards between columns to update their stage. Cards show thread status, git sync state, cost, and time since last update. Pinned threads appear first in each column. You can create new threads directly from the board and switch between list and board views.

## Search & Filtering

Find threads quickly using the search bar. Search matches against:

- **Thread title**
- **Branch name**
- **Thread status**
- **Message content** (server-side full-text search with content snippets)

Results highlight matching text. Combine search with filters for status, git state, and mode to narrow results further. Filters sync to URL query parameters so you can share filtered views.

## Analytics

The analytics dashboard provides an overview of task activity and costs:

- **Metric cards** — Tasks created, completed, moved to review/done/archived, and total cost
- **Stage distribution chart** — Pie chart showing current distribution of threads across stages
- **Timeline chart** — Bar chart showing task activity over time, grouped by day/week/month/year

Filter analytics by project and time range (day, week, month, or all-time).

## Mobile Support

funny includes a dedicated mobile view that automatically activates on screens narrower than 768px. The mobile interface provides a streamlined, touch-friendly experience for monitoring and interacting with your agents on the go.

**Mobile features:**

- **Stack-based navigation** — Projects → Threads → Chat, with back buttons for easy navigation
- **Full chat interaction** — Send messages, view agent responses, approve/reject tool calls, and monitor running agents
- **Thread management** — Create new threads with model and mode selection directly from your phone
- **Status monitoring** — Real-time status badges and agent activity indicators
- **Auto-scrolling** — Smart scroll behavior that follows new messages while preserving your scroll position

The sidebar automatically converts to a slide-out drawer on mobile via the shadcn/ui Sheet component.

## Browser Annotator Panel

A side panel that lets you load any URL, mark it up visually (pin / region / draw), and send the annotations as a new thread to a Claude agent. **The panel is per-project** — open it from the `AppWindow` icon in the project header (next to Terminal / Review / Tests). Sends go to the project you opened it from; there's no project selector inside the panel.

**How it works:** the runner spawns a real Chromium subprocess via Playwright's bundled binary and streams JPEG frames via [CDP `Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast) to a `<canvas>`. Loads **any URL** (no X-Frame-Options limit). Input (mouse / keyboard) is forwarded via `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. DOM inspection (selector / test-id / component name / computed styles) runs in the page context via `Runtime.evaluate` using helpers from [`@funny/shared/dom/extract`](packages/shared/src/dom/extract.ts) — the same source the Chrome extension consumes.

**Setup:**

```bash
# If Playwright's executablePath resolves inside a sandbox (e.g. VSCode flatpak),
# point at the real Chromium binary location:
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright

# Make sure Chromium is installed:
bunx playwright install chromium
```

**Tools:**

- **Browse** — click / type / scroll forwarded to the embedded page via CDP
- **Pin** — single-click marker with a note, captures the DOM element under the cursor
- **Region** — drag a rectangle, captures every element that intersects
- **Draw** — 5-color free-hand annotations
- 🏷 **Show test-ids** — overlays every `[data-testid]` with a label badge
- ⏸ **Pause animations** — freezes CSS / Web Animations in the embedded page
- 🔍 **Inspect mode** — hover shows selector / testid / component name / dimensions; same affordance is active under the Pin tool so you see what you'll capture before clicking
- 📷 **Screenshot viewport** — copies the current frame as PNG to the clipboard
- ⏪ **Back / Forward / Reload** — run `history.back/forward()` / `location.reload()` in the page context

**Send** → creates a thread with the URL + annotations as the first message + draw image attached. Annotations are formatted via [`browser-panel-markdown.ts`](packages/client/src/lib/browser-panel-markdown.ts).

The CDP implementation lives in [`packages/runtime/src/services/browser-session-manager.ts`](packages/runtime/src/services/browser-session-manager.ts) (runner side) and [`packages/client/src/components/browser-panel/`](packages/client/src/components/browser-panel/) (client side). Background and design decisions: [`openspec/changes/archive/2026-05-24-browser-panel-cdp-runtime/`](openspec/changes/archive/2026-05-24-browser-panel-cdp-runtime/). Screenshot follow-ups for non-CDP contexts: [`docs/design/browser-panel-screenshot.md`](docs/design/browser-panel-screenshot.md).

## Visualizer Plugins

funny renders rich views for fenced code blocks and file previews — diagrams, tables, and more — through **visualizer plugins**. The built-in **Mermaid** (diagrams) and **CSV** (tables) renderers use the same contract third-party plugins do, so the system is fully extensible without touching the core. Heavy/niche renderers ship as installable extensions instead.

```bash
funny ext list                                     # List installed visualizer plugins
funny ext install github:ironmussa/funny-extensions --subdir visualizer-dbml   # Install the DBML ER-diagram plugin
funny ext remove visualizer-dbml                   # Remove it
```

Or manage them from **Settings → Extensions** in the UI. Plugins live on the server host at `~/.funny/extensions/`.

> **Full trust, no sandbox** — a plugin runs inside your authenticated session, like installing an npm package. Install only what you trust. Installing/removing is admin-only.

Full guide — installing, managing, and **creating** plugins (the `@funny/plugin-sdk` package, the `VisualizerPlugin` contract, building to ESM, the shared-React import map): [`docs/visualizer-plugins.md`](docs/visualizer-plugins.md). Reference extensions live in their own repo: [`ironmussa/funny-extensions`](https://github.com/ironmussa/funny-extensions) — e.g. [`visualizer-dbml`](https://github.com/ironmussa/funny-extensions/tree/master/visualizer-dbml) (DBML → interactive ER diagram, React Flow — fully decoupled, bundles its own deps).

## Agent Providers

Besides Claude, funny can drive other coding agents over **ACP** (Agent Client Protocol) — Codex, Gemini, Cursor, opencode, and more. These are **agent providers**: each is a small declarative manifest pointing at an agent CLI already installed on your **runner**. You can trim which built-in providers appear, and install third-party ones — without touching the core. Claude is always available.

Manage everything from **Settings → Providers** (gear icon at the bottom of the sidebar → **Providers**, or open `/preferences/providers` directly):

- **Built-in providers** — toggle each bundled ACP provider (Codex / Gemini / pi / Cursor / opencode) on or off with **Enable / Disable**. The change is live (no restart) and updates the model picker immediately. It's **session-scoped** — see `FUNNY_PROVIDERS` below to make a lean set the default.
- **Installed providers** — install a third-party provider from a git repo or a local path on the runner, or remove one. On install, funny discloses the exact binary the provider will launch.

```bash
# On the RUNNER, choose which built-in ACP providers are active by default.
# Comma-separated ids; Claude is always on. Unset = all built-ins (no change).
FUNNY_PROVIDERS=claude,codex   # only Codex appears in the picker (besides Claude)
```

Where it shows: the **model picker** (in the New Thread dialog and the prompt input) lists only the active providers. Disable a provider — or leave it out of `FUNNY_PROVIDERS` — and it disappears from the picker. Re-enable it from Settings → Providers and it comes back, no restart.

> **Runner-owned & full trust** — providers live on your runner and let funny spawn the binary they declare. Install only providers you trust. Built-in toggles are session-scoped; set `FUNNY_PROVIDERS` on the runner to persist a lean default across restarts.

## Development

```bash
# Install dependencies
bun install

# Run in development mode (client + server with hot reload)
bun run dev

# Run only server (port 3001)
bun run dev:server

# Run only client (port 5173)
bun run dev:client

# Build for production
bun run build

# Database operations
bun run db:push    # Push schema changes
bun run db:studio  # Open Drizzle Studio

# Run tests
bun test
```

### Named local domains (portless)

When you run several apps locally it's easy to lose track of which one is on
which port. [portless](https://github.com/vercel-labs/portless) puts a small
local proxy in front of the dev servers so each gets a stable, named URL
instead of a bare port:

| URL | → port | service |
| --- | --- | --- |
| `http://funny.localhost` | 5173 | client |
| `http://api.funny.localhost` | 5002 | server |
| `http://runner.funny.localhost` | 3003 | runtime |

We use portless in **static-alias + HTTP (`--no-tls`) mode**: the services keep
their fixed ports (so the cross-service references — Vite → `:5002`,
`RUNNER_PUBLIC_MEDIA_URL` → `:3003` — stay intact) and everything stays on HTTP
(so the browser-reachable runner media URL doesn't trip mixed-content blocking).
portless just maps a name onto each existing port.

**One-time setup:**

```bash
# Install the CLI
npm install -g portless

# Start the HTTP proxy on port 80. Needs sudo once to bind :80.
# Use `service install` instead of `proxy start` to persist across reboots.
sudo portless proxy start --no-tls
# sudo portless service install --no-tls   # auto-start on boot

# Register the routes (persisted in portless state; idempotent)
bun run portless:routes
```

The `.env` `CORS_ORIGIN` must include `http://funny.localhost` so the server and
better-auth accept the new origin (already configured in the sample `.env`).

**Daily use:**

```bash
bun run dev:portless   # registers routes, then runs the full dev stack
bun run portless:list  # show active routes
```

Then open **http://funny.localhost**. To bypass portless and use raw ports,
run `bun run dev` as usual, or prefix any command with `PORTLESS=0`.

> Without sudo, portless falls back to port `1355`
> (`http://funny.localhost:1355`). The named domain still disambiguates your
> apps; only the clean `:80` URL requires the one-time sudo above.

## Architecture

### Monorepo Structure

- **`packages/shared`** — Shared TypeScript types and runner protocol definitions
- **`packages/core`** — Reusable agent orchestration and git logic
- **`packages/runtime`** — Hono HTTP server with [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (port 3001)
- **`packages/client`** — React 19 + Vite SPA (port 5173 in dev)
- **`packages/server`** — Team coordination server (users, projects, memberships, runner management)
- **`packages/runner`** — Runner module for connecting to the central server

### Tech Stack

**Server:**

- Hono (HTTP framework)
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (`@anthropic-ai/claude-agent-sdk`)
- Drizzle ORM + SQLite
- WebSocket (real-time updates)

**Client:**

- React 19
- Vite
- Zustand (state management)
- shadcn/ui (components)
- Tailwind CSS

## Data Storage

**funny** (local app) stores data in:

```
~/.funny/
├── .env              # Optional local env file; team connection keys are ignored by the CLI
├── data.db           # SQLite database (projects, threads, messages)
├── admin-password.txt # Generated first-run admin password; delete after rotating
├── auth-token        # Bearer token for local auth
├── auth-secret       # Session secret (multi-user mode)
└── encryption.key    # AES-256-GCM key for GitHub token encryption
```

**funny-server** (team server) stores data separately in:

```
~/.funny-central/
├── central.db        # SQLite database (users, projects, memberships, runners)
├── admin-password.txt # Generated first-run admin password; delete after rotating
├── auth-secret       # Session secret
└── encryption.key    # AES-256-GCM key for token encryption
```

## Git Worktrees

Worktrees are created in `.funny-worktrees/` adjacent to your project:

```
/your-project/
├── .git/
├── src/
└── ...

/your-project-worktrees/
├── feature-branch-1/
├── feature-branch-2/
└── ...
```

Each worktree is an isolated working directory allowing parallel agent work without conflicts.

## Chrome Extension

The `packages/chrome-extension` package contains a Chrome extension for selecting and annotating UI elements, then sending them to Funny for AI-powered analysis and fixes.

### Building the Extension

```bash
# Install dependencies (from the repo root)
bun install

# Build the extension
cd packages/chrome-extension
bun run build
```

This compiles the TypeScript source files (`src/`) into JavaScript files in the package root, ready for Chrome to load.

### Loading in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `packages/chrome-extension` folder
5. The extension icon should appear in your toolbar

### Development (watch mode)

```bash
cd packages/chrome-extension
bun run watch
```

This watches for changes in `src/` and rebuilds automatically. After each rebuild, click the reload button on `chrome://extensions` to pick up the changes.

## Commands

See [CLAUDE.md](./CLAUDE.md) for detailed commands and architecture documentation.

## License

MIT

## Support

- [GitHub Issues](https://github.com/ironmussa/funny/issues)
- [Claude Code Documentation](https://claude.ai/code)

## Contributing

Contributions are welcome! Please read [CLAUDE.md](./CLAUDE.md) for development guidelines.

---

Built with [Claude Code](https://claude.ai/code)
