<div align="center">

# a-parallel

### Run multiple AI coding agents at the same time. On the same repo. Without conflicts.

**Parallel agent orchestration for Claude Code, powered by git worktrees.**

[Getting Started](#getting-started) &bull; [Features](#features) &bull; [How It Works](#how-it-works) &bull; [Architecture](#architecture)

</div>

---

I built this because I had **seven VS Code windows open at the same time** — one per project, each with multiple Claude Code agents running, each needing attention. Alt-tabbing between them, losing context, forgetting which window was doing what. It was chaos.

**a-parallel** replaces all of that with a single UI. Spin up multiple Claude Code agents working on the same repository simultaneously — each on its own isolated branch — and review, commit, and merge their work from one place. It's like having a team of engineers that never step on each other's toes, managed from a single control room.

> Think [OpenAI Codex](https://openai.com/index/introducing-codex/) but self-hosted, open, and built around **parallel execution** as a first-class concept.

---

## Why a-parallel?

| Problem | Solution |
|---|---|
| Seven VS Code windows open, each with an agent | **One dashboard** to manage all your agents and projects |
| Running one agent at a time is slow | Launch **multiple agents in parallel**, each on its own branch |
| Agents overwrite each other's files | **Git worktrees** give every agent an isolated working directory |
| Switching between tasks kills your flow | A **single UI** shows all running agents, their progress, and diffs |
| Reviewing AI-generated code is tedious | Built-in **diff viewer** with stage, unstage, revert, commit, push, and PR — all in one pane |
| CLI-only tools lack visibility | **Real-time streaming UI** shows every tool call, file edit, and bash command as it happens |

---

## Features

### Parallel Agent Orchestration
Run 2, 5, or 10 Claude agents at the same time on the same repository. Each agent gets its own git worktree and branch — complete filesystem isolation with zero merge conflicts.

### Real-Time Streaming
Watch agents think, code, and execute in real time. Every tool call, file write, bash command, and reasoning step streams to your browser via WebSocket.

### Built-In Code Review
A full git workflow lives inside the app. View diffs with syntax highlighting, stage or revert individual files, write commit messages, push to remote, and open pull requests — without leaving the window.

### Multiple Permission Modes
Control how much autonomy each agent gets:
- **Plan** — Agent describes what it will do before doing it
- **Auto Edit** — Agent applies changes automatically
- **Confirm Edit** — Agent asks for approval before each edit

### Project Management
Organize work by project. Each project points to a git repository, and threads within it represent individual tasks. Archive completed threads, track costs, and resume interrupted sessions.

### Model Flexibility
Switch between Claude models per thread — use **Haiku** for quick tasks, **Sonnet** for everyday coding, **Opus** for complex architectural work.

### Skills & MCP Servers
Extend what your agents can do. Install **Claude skills** to give agents specialized knowledge and workflows, and connect **MCP (Model Context Protocol) servers** to plug in external tools — databases, APIs, custom integrations — all configurable per project from the settings panel.

### Desktop & Web
Runs in the browser during development, or as a **native desktop app** via Tauri with an integrated terminal (xterm.js), system clipboard access, and cross-platform support.

### Internationalization
Interface available in English, Spanish, and Portuguese.

---

## How It Works

1. **You create a thread** with a prompt, a model, and a mode (local or worktree).
2. **a-parallel spawns a Claude CLI process** in an isolated git worktree with its own branch.
3. **The agent works** — reading files, writing code, running commands — while streaming every action to the UI.
4. **You review the diff** in the built-in review pane, stage what you want, and commit/push/open a PR.
5. **Meanwhile**, other agents are doing the same thing on other branches. In parallel. At the same time.

---

## Getting Started

### Prerequisites

- **Node.js** 18+ and **npm**
- **Git** installed and available in PATH
- **Claude Code CLI** installed (`npm install -g @anthropic-ai/claude-code`)
- A valid **Anthropic API key** configured for Claude Code

### Installation

```bash
# Clone the repository
git clone https://github.com/anthropics/a-parallel.git
cd a-parallel

# Install dependencies
npm install

# Initialize the database
npm run db:push

# Start development server
npm run dev
```

The client opens at `http://localhost:5173` and the API runs on `http://localhost:3001`.

### First Steps

1. Click **Add Project** and select a local git repository.
2. Create a **New Thread** — pick a model, choose worktree mode, and write your prompt.
3. Watch the agent work in real time.
4. Open the **Review Pane** to see diffs, stage files, and commit.
5. Create more threads for parallel tasks.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui, Zustand, XState |
| **Backend** | Hono, SQLite, Drizzle ORM, WebSocket |
| **Agent** | Claude Code CLI (NDJSON streaming) |
| **Desktop** | Tauri 2 (Rust) |
| **Isolation** | Git worktrees |

---

## Architecture

```
a-parallel/
├── packages/
│   ├── shared/     # TypeScript types (no runtime code)
│   ├── server/     # Hono API + Claude agent orchestration
│   └── client/     # React SPA
├── src-tauri/      # Native desktop app (Rust)
└── scripts/
```

**Server** — Hono HTTP server that spawns Claude CLI processes, manages git worktrees, persists everything to SQLite, and broadcasts real-time events over a multiplexed WebSocket.

**Client** — React 19 SPA with modular Zustand stores, real-time WebSocket updates, and a component library built on shadcn/ui.

**Shared** — Zero-runtime TypeScript package with all interfaces and types shared between server and client.

---

## Development

```bash
npm run dev              # Run server + client
npm run dev:server       # Server only (port 3001)
npm run dev:client       # Client only (port 5173)
npm run build            # Build all packages
npm run db:push          # Push database schema
npm run db:studio        # Open Drizzle Studio
npm test                 # Run tests
```

---

## License

MIT
