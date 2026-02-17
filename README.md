# funny

> Parallel Claude Code agent orchestration powered by git worktrees

funny is a web UI for orchestrating multiple [Claude Code](https://claude.ai/code) agents in parallel. It uses git worktrees to let each agent work on its own branch simultaneously without conflicts. Think of it as a Codex App clone powered by the Claude Agent SDK.

## Features

- **Parallel agent execution** — Run multiple Claude Code agents simultaneously on different branches
- **Git worktree isolation** — Each agent gets its own isolated working directory
- **Real-time monitoring** — WebSocket-based live updates for all agent activities
- **Git integration** — Built-in diff viewer, staging, commits, and PR creation
- **Dual authentication modes** — Single-user local mode or multi-user with Better Auth
- **MCP support** — Model Context Protocol integration
- **Automation scheduling** — Cron-based recurring tasks

## Installation

### Quick Start (npx)

No installation needed! Run directly with:

\`\`\`bash
npx funny
\`\`\`

The app will start and open at \`http://localhost:3001\`

### Global Installation

\`\`\`bash
npm install -g funny
funny
\`\`\`

### From Source

\`\`\`bash
git clone https://github.com/anthropics/funny.git
cd funny
npm install
npm run build
npm start
\`\`\`

## Requirements

- **Bun** >= 1.0.0 (install from [bun.sh](https://bun.sh))
- **Claude CLI** installed and authenticated ([claude.ai/code](https://claude.ai/code))
- **Git** installed and configured

## Usage

### Starting the Server

\`\`\`bash
# Default (local mode, port 3001)
funny

# Custom port
funny --port 8080

# Multi-user mode
funny --auth-mode multi

# Show all options
funny --help
\`\`\`

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| \`-p, --port <port>\` | Server port | \`3001\` |
| \`-h, --host <host>\` | Server host | \`127.0.0.1\` |
| \`--auth-mode <mode>\` | Authentication mode (\`local\` or \`multi\`) | \`local\` |
| \`--help\` | Show help message | - |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| \`PORT\` | Server port | \`3001\` |
| \`HOST\` | Server hostname | \`127.0.0.1\` |
| \`AUTH_MODE\` | Authentication mode (\`local\` or \`multi\`) | \`local\` |
| \`CORS_ORIGIN\` | Custom CORS origins (comma-separated) | Auto-configured |

## Authentication Modes

### Local Mode (default)

Single-user mode with automatic bearer token authentication. Perfect for personal use.

- No login page
- Token auto-generated at \`~/.funny/auth-token\`
- All data stored locally

### Multi-User Mode

Multiple users with login page and admin-managed accounts.

\`\`\`bash
AUTH_MODE=multi funny
\`\`\`

Default admin credentials:
- **Username:** \`admin\`
- **Password:** \`admin\`

Features:
- Cookie-based sessions (7-day expiry)
- Per-user data isolation
- Admin user management
- Per-user git identity and GitHub tokens

## Development

\`\`\`bash
# Install dependencies
npm install

# Run in development mode (client + server with hot reload)
npm run dev

# Run only server (port 3001)
npm run dev:server

# Run only client (port 5173)
npm run dev:client

# Build for production
npm run build

# Database operations
npm run db:push    # Push schema changes
npm run db:studio  # Open Drizzle Studio

# Run tests
npm test
\`\`\`

## Architecture

### Monorepo Structure

- **\`packages/shared\`** — Shared TypeScript types
- **\`packages/server\`** — Hono HTTP server with Claude Agent SDK (port 3001)
- **\`packages/client\`** — React 19 + Vite SPA (port 5173 in dev)

### Tech Stack

**Server:**
- Hono (HTTP framework)
- Claude Agent SDK
- Drizzle ORM + SQLite
- Better Auth (multi-user mode)
- WebSocket (real-time updates)

**Client:**
- React 19
- Vite
- Zustand (state management)
- shadcn/ui (components)
- Tailwind CSS

## Data Storage

All data is stored in:

\`\`\`
~/.funny/
├── data.db           # SQLite database (projects, threads, messages)
├── auth-token        # Local mode bearer token
├── auth-secret       # Multi-user mode session secret
└── encryption.key    # GitHub token encryption key (multi-user)
\`\`\`

## Git Worktrees

Worktrees are created in \`.funny-worktrees/\` adjacent to your project:

\`\`\`
/your-project/
├── .git/
├── src/
└── ...

/your-project-worktrees/
├── feature-branch-1/
├── feature-branch-2/
└── ...
\`\`\`

Each worktree is an isolated working directory allowing parallel agent work without conflicts.

## Commands

See [CLAUDE.md](./CLAUDE.md) for detailed commands and architecture documentation.

## License

MIT

## Support

- [GitHub Issues](https://github.com/anthropics/funny/issues)
- [Claude Code Documentation](https://claude.ai/code)

## Contributing

Contributions are welcome! Please read [CLAUDE.md](./CLAUDE.md) for development guidelines.

---

Built with ❤️ using [Claude Code](https://claude.ai/code)
