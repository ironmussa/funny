# Process Cleanup & Ghost Socket Troubleshooting

## Quick Fix: UI stuck on skeletons after server restart

```bash
# 1. Stop everything (Ctrl+C on all terminals)

# 2. Check for ghost sockets
netstat -ano | findstr :3001 | findstr LISTENING

# 3. If you see multiple PIDs or dead PIDs, clean up:
bun packages/server/src/kill-port.ts

# 4. Restart
bun run dev

# 5. Hard refresh the browser: Ctrl+Shift+R
```

## The Root Cause: Windows Handle Inheritance

On Windows, when a process spawns a child using `CreateProcess` with `bInheritHandles=TRUE`, the child inherits **ALL** open handles from the parent — not just stdio, but also TCP sockets, file handles, etc.

```
Server (Bun, listening on :3001)
  └── SDK spawns node.exe (inherits server socket!)
       └── Hot reload kills server... but node.exe keeps the socket alive
            └── Ghost socket: TCP LISTEN on :3001 with dead PID
```

When the server hot-reloads (file change), the old worker process dies but its child processes survive with inherited copies of the server's listening socket. New connections can be routed to the ghost socket instead of the live server, causing the UI to hang forever on skeletons.

### How we confirmed this

1. `netstat -ano | findstr :3001` showed **two LISTEN entries** — one live, one from a dead PID
2. `Get-Process -Id <ghost_pid>` → process doesn't exist
3. `Get-NetTCPConnection` showed Vite proxy had `Established` connections to the ghost
4. Even `curl http://127.0.0.1:3001/api/health` hung (ghost intercepted the connection)
5. Killing **all node.exe** processes freed the ghost socket — confirming a node.exe child held the inherited handle
6. The user confirmed an MCP server was running at the time — MCP servers are long-lived child processes that inherit the socket

### Why `bun --watch` makes it worse

`bun --watch` on Windows forks worker processes (new PID per reload). Each worker has its own `globalThis`, so the cleanup pattern (`__bunCleanup` on globalThis) doesn't work — the new worker can't access the old worker's cleanup functions. The old worker is killed without running any cleanup, and its children (agents, MCP servers) survive with the inherited socket.

## Solutions: Defense in Depth

### Layer 1 (Root Cause Fix): Prevent socket inheritance in agent processes

**File:** `packages/core/src/agents/sdk-claude.ts:72-102`

The Claude Agent SDK has a `spawnClaudeCodeProcess` hook that controls how it spawns its subprocess. On Windows, we provide a custom spawn function that uses `stdio: ['pipe', 'pipe', 'pipe']` — this triggers `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` in Node.js/libuv, which restricts handle inheritance to only the pipe handles. The server socket is NOT inherited.

```typescript
if (process.platform === 'win32' && !sdkOptions.spawnClaudeCodeProcess) {
  const { spawn } = await import('child_process');
  sdkOptions.spawnClaudeCodeProcess = (options) => {
    const child = spawn(options.command, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'], // ← triggers HANDLE_LIST restriction
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
    });
    // wire abort signal...
    return child;
  };
}
```

Same pattern already used by:

- `sandbox-manager.ts:490` (Podman execution)
- `pty-manager.ts:23-31` (PTY helper with explicit comment about handle inheritance)

### Layer 2: Kill entire process tree on dev reload

**File:** `packages/server/src/dev-watch.ts`

Replaced `bun --watch` with manual file watching + `taskkill /F /T /PID` on every reload. This kills the server AND all its children, preventing ghost sockets even if Layer 1 misses something (e.g., MCP server processes spawned by the SDK internally without the custom hook).

### Layer 3: Clean ghost sockets at startup

**File:** `packages/server/src/kill-port.ts` (called from `index.ts:4-6`)

Runs before `Bun.serve()` on Windows. Detects ghost sockets by checking if listening PIDs are alive. If ghost PIDs are found, hunts for processes holding inherited handles by scanning all TCP connections on the port.

### Layer 4: Vite proxy timeout

**File:** `packages/client/vite.config.ts:46`

Added `timeout: 10000` to the API proxy. If a cached connection to a ghost socket hangs, it times out after 10 seconds instead of hanging forever. The client can then retry on a fresh connection to the live server.

### Layer 5: Circuit breaker reset on WebSocket reconnect

**File:** `packages/client/src/hooks/use-ws.ts`

When the WebSocket connects, resets the HTTP circuit breaker immediately. Without this, the circuit breaker stays open for 15 seconds after the server comes back, blocking all API requests.

## Architecture: ShutdownManager

All cleanup is centralized in `packages/server/src/services/shutdown-manager.ts` using a registry pattern. Services self-register at import time.

```
                    shutdownManager (singleton)
                              │
                  .run('hard') or .run('hotReload')
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
     Phase 0 (SERVER)   Phase 1 (SERVICES)   Phase 2 (DATABASE)  →  Phase 3 (FINAL)
     server.stop(true)  [parallel]:           closeDatabase()        taskkill /F /T
                        - agents                                     process.exit
                        - PTY
                        - scheduler
                        - commands
                        - timers
                        - telemetry

Each service self-registers at import time:
  shutdownManager.register('name', cleanupFn, phase)
```

### Registered services

| Service              | File                     | Phase    | Notes                            |
| -------------------- | ------------------------ | -------- | -------------------------------- |
| http-server          | index.ts                 | SERVER   | Releases port immediately        |
| observability        | index.ts                 | SERVICES | Flushes telemetry (hard only)    |
| automation-scheduler | automation-scheduler.ts  | SERVICES | Stops cron jobs + polling timer  |
| pty-manager          | pty-manager.ts           | SERVICES | taskkill /F /T on Windows        |
| agent-runner         | agent-runner.ts          | SERVICES | Mode-aware: extract vs kill      |
| command-runner       | command-runner.ts        | SERVICES | Kills all running commands       |
| rate-limit-timer     | middleware/rate-limit.ts | SERVICES | Clears prune interval            |
| mcp-oauth-timer      | mcp-oauth.ts             | SERVICES | Clears state cleanup interval    |
| database             | db/index.ts              | DATABASE | WAL checkpoint + close           |
| process-exit         | index.ts                 | FINAL    | Windows tree kill + process.exit |

### Two shutdown modes

- **`hard`** (Ctrl+C / SIGINT): kills everything, exits process
- **`hotReload`** (dev-watch file change): kills process tree, restarts fresh

### Adding a new service

Just add this at the bottom of your service file:

```typescript
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
shutdownManager.register('my-service', () => myCleanupFunction(), ShutdownPhase.SERVICES);
```

No changes needed in `index.ts`.

## Diagnosing port issues

```bash
# See what's on port 3001
netstat -ano | findstr :3001

# Check if a PID is alive or ghost
powershell -Command "Get-Process -Id <PID>"

# Full TCP state with process info
powershell -Command "Get-NetTCPConnection -LocalPort 3001 | Select OwningProcess,State | Format-Table"

# Kill a specific process tree
taskkill /F /T /PID <PID>

# Nuclear: kill ALL processes with connections to port 3001
powershell -Command "Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

# If ghost persists after killing known processes, find ALL node.exe and kill them
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"
```

## Logs

Server logs persist to `~/.funny/logs/server-YYYY-MM-DD.log` (rotated daily, 7 days).

```bash
# View today's log
cat ~/.funny/logs/server-2026-02-22.log

# Search for errors
grep "error" ~/.funny/logs/server-*.log

# Follow the log in real time
tail -f ~/.funny/logs/server-2026-02-22.log
```

## Key files

| File                                                  | Role                                               |
| ----------------------------------------------------- | -------------------------------------------------- |
| `packages/core/src/agents/sdk-claude.ts`              | Root cause fix: custom spawn with handle isolation |
| `packages/server/src/services/shutdown-manager.ts`    | Centralized shutdown registry                      |
| `packages/server/src/kill-port.ts`                    | Pre-startup ghost socket cleanup                   |
| `packages/server/src/dev-watch.ts`                    | Dev wrapper: file watch + process tree kill        |
| `packages/client/vite.config.ts`                      | Proxy timeout (10s) to prevent infinite hangs      |
| `packages/client/src/hooks/use-ws.ts`                 | WebSocket reconnection + circuit breaker reset     |
| `packages/client/src/stores/circuit-breaker-store.ts` | HTTP circuit breaker (opens after 3 failures)      |
| `packages/client/src/stores/auth-store.ts`            | Auth init (`_bootstrapPromise` at module load)     |
| `packages/server/src/services/pty-manager.ts`         | PTY helper with handle isolation pattern           |
| `packages/core/src/containers/sandbox-manager.ts`     | Sandbox spawn with same handle isolation pattern   |
