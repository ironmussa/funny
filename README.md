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
bunx @ironmussa/funny
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

### Starting the Server

```bash
# Default (port 3001)
funny

# Custom port
funny --port 8080

# Show all options
funny --help
```

### CLI Options

| Option              | Description       | Default     |
| ------------------- | ----------------- | ----------- |
| `-p, --port <port>` | Server port       | `3001`      |
| `-h, --host <host>` | Server host       | `127.0.0.1` |
| `--help`            | Show help message | -           |

### Environment Variables

| Variable      | Description                           | Default         |
| ------------- | ------------------------------------- | --------------- |
| `PORT`        | Server port                           | `3001`          |
| `HOST`        | Server hostname                       | `127.0.0.1`     |
| `CORS_ORIGIN` | Custom CORS origins (comma-separated) | Auto-configured |

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

- **`packages/shared`** — Shared TypeScript types
- **`packages/server`** — Hono HTTP server with [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (port 3001)
- **`packages/client`** — React 19 + Vite SPA (port 5173 in dev)

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

All data is stored in:

```
~/.funny/
├── data.db           # SQLite database (projects, threads, messages)
└── auth-token        # Bearer token for authentication
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
