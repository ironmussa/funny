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
- **MCP support** — Model Context Protocol integration
- **Automation scheduling** — Cron-based recurring tasks
- **Mobile support** — Responsive mobile view with touch-friendly navigation for on-the-go monitoring

## Installation

### Quick Start (bunx)

No installation needed! Run directly with:

```bash
bunx @ironmussa/funny@lastest
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

Open `http://localhost:3001` in your browser. That's it.

### Team Mode (Multiple Users)

Team mode lets multiple users collaborate on shared projects. It requires two components:

1. **Central server** (`funny-server`) — Runs on a shared machine. Manages users, projects, memberships, and coordinates runners.
2. **Local runner** (`funny --team <url>`) — Each team member runs funny locally and connects to the central server.

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
- **Password:** `admin`

The admin can create additional user accounts from the central server's API.

#### Step 2: Each team member connects

Each team member runs funny locally with the `--team` flag:

```bash
funny --team http://<central-server-ip>:3002
```

This starts the full funny app locally (UI, git, agents) **and** connects to the central server to:
- Authenticate and see team projects
- Sync thread state across the team
- Receive dispatched tasks from the central server

Each member's git operations and Claude agents run **on their own machine**, in their own local repos. The central server only coordinates — it never touches your filesystem.

#### Team mode architecture

```
Team member A                    Team member B
┌──────────────────┐            ┌──────────────────┐
│ funny --team URL │            │ funny --team URL │
│ ┌──────────────┐ │            │ ┌──────────────┐ │
│ │ Local git    │ │            │ │ Local git    │ │
│ │ Local agents │ │            │ │ Local agents │ │
│ │ Local SQLite │ │            │ │ Local SQLite │ │
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

| Option                | Description                              | Default     |
| --------------------- | ---------------------------------------- | ----------- |
| `-p, --port <port>`   | Server port                              | `3001`      |
| `-h, --host <host>`   | Server host                              | `127.0.0.1` |
| `--auth-mode <mode>`  | Authentication mode: `local` or `multi`  | `local`     |
| `--team <url>`        | Connect to a central team server         | -           |
| `--help`              | Show help message                        | -           |

**funny-server** (team coordination server)

| Option                | Description                              | Default     |
| --------------------- | ---------------------------------------- | ----------- |
| `-p, --port <port>`   | Server port                              | `3002`      |
| `-h, --host <host>`   | Server host                              | `0.0.0.0`   |
| `--help`              | Show help message                        | -           |

### Environment Variables

| Variable                 | Description                           | Default         | Used by          |
| ------------------------ | ------------------------------------- | --------------- | ---------------- |
| `PORT`                   | Server port                           | `3001` / `3002` | both             |
| `HOST`                   | Server hostname                       | `127.0.0.1`     | both             |
| `AUTH_MODE`              | Authentication mode (`local`/`multi`) | `local`         | funny            |
| `TEAM_SERVER_URL`        | Central server URL (same as `--team`) | -               | funny            |
| `CORS_ORIGIN`            | Custom CORS origins (comma-separated) | Auto-configured | both             |
| `FUNNY_CENTRAL_DATA_DIR` | Central server data directory         | `~/.funny-central` | funny-server |
| `LOG_LEVEL`              | Log level (debug/info/warn/error)     | `info`          | funny-server    |

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
├── data.db           # SQLite database (projects, threads, messages)
├── auth-token        # Bearer token for local auth
├── auth-secret       # Session secret (multi-user mode)
└── encryption.key    # AES-256-GCM key for GitHub token encryption
```

**funny-server** (team server) stores data separately in:

```
~/.funny-central/
├── central.db        # SQLite database (users, projects, memberships, runners)
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
