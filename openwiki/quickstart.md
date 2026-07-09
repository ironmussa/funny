# funny — quickstart

funny (`@ironmussa/funny`) is a local-first and team workspace for running multiple coding agents (Claude, Codex, Gemini, Pi, Cursor, opencode, Deep Agent, and other ACP-compatible providers) in parallel. Each agent thread runs in its own isolated git worktree, streams its session into a web UI in real time, and exposes review/terminal/browser/git controls so many tasks can move at once. See [README.md](../README.md) for the full feature list and [INSTALL.md](../INSTALL.md) for setup scenarios.

It ships as a Bun workspaces monorepo with **19 packages** under `packages/*`, a CLI entrypoint (`bin/funny.js`), and an optional Tauri desktop shell (`src-tauri/`).

> **Note on the repo's own `CLAUDE.md`:** the top-level [`CLAUDE.md`](../CLAUDE.md) describes an older, 5-package architecture (`shared`, `core`, `runtime`, `server`, `client`) and predates 14 of the packages that exist today (`agent`, `api-acp`, `chrome-extension`, `design-client`, `evflow`, `harness`, `memory`, `native-git`, `pipelines`, `plugin-sdk`, `reviewbot`, `scheduler`, `sdk`, `workflows`). Its description of the core client/server/runtime split and the `neverthrow` / runner-isolation / scratch-thread rules is still accurate and is the basis for several pages below — but treat its package inventory as stale. This wiki calls out every other place source code has moved on from what `CLAUDE.md` says.

## Where to go next

| Page | What it covers |
| --- | --- |
| [architecture/overview.md](./architecture/overview.md) | Full package map (all 19 packages), what's live app vs. standalone service vs. experimental, deployment topology |
| [architecture/agent-execution.md](./architecture/agent-execution.md) | End-to-end trace of a live chat thread: client → server → runner → agent process → WebSocket back |
| [architecture/pipelines-and-automation.md](./architecture/pipelines-and-automation.md) | Post-commit review/fix pipeline, the `@funny/pipelines` engine, scheduler, and automations |
| [domain/threads-and-worktrees.md](./domain/threads-and-worktrees.md) | Thread modes (local/worktree), scratch threads, team sharing levels and the steer-delegation exception |
| [integrations/extensions-and-services.md](./integrations/extensions-and-services.md) | Multi-provider agents, visualizer plugins, MCP, native-git, and the standalone services (`agent`, `api-acp`, `reviewbot`, `memory`, `design-client`) |
| [operations/deployment-and-auth.md](./operations/deployment-and-auth.md) | Local vs. team deployment, auth/admin bootstrap (and a stale-doc fix), per-user git identity, trust boundaries, desktop packaging |
| [workflows/development.md](./workflows/development.md) | Dev commands, TypeScript/lint/format tooling, fitness/architecture guardrails, testing, CI |

## Fastest path to running it

```bash
bun install
bun run dev        # server (3001) + runner (3003) + client (5173) + scheduler, concurrently
```

Do **not** run `bun run dev` (or any `--watch`/`vite` process) from an automated agent session — it hangs forever. Use `bun run build` or `bun run typecheck` to verify changes instead. See [workflows/development.md](./workflows/development.md).

## Quick facts

- **Runtime:** Bun (`>=1.4.0-0` per `package.json` `packageManager`/`engines`), Node `>=22.19.0 <23` as a fallback target.
- **Workspaces:** `packages/*` (root `package.json:17-19`).
- **Persistence:** SQLite (`bun:sqlite` + Drizzle) by default at `~/.funny/data.db`, PostgreSQL optional via `DATABASE_URL`.
- **License:** MIT.
