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
# Or separately:
bun run dev:server
bun run dev:client

# 5. Hard refresh the browser: Ctrl+Shift+R
```

## The Problem (What Happened)

After pressing Ctrl+C to stop the server, the UI got permanently stuck on skeleton loaders. Refreshing the page didn't help. The server appeared to restart fine (logs showed `Listening on http://localhost:3001` and HTTP requests returned 200), but the frontend was completely unresponsive.

### Investigation timeline

**1. First theory: Circuit breaker blocking the UI**

The client has a circuit breaker that opens after 3 failed HTTP requests, showing a full-screen "server unavailable" overlay. We thought it was staying open after the server came back.

- **Finding:** The circuit breaker auto-probes `/api/health` every 15 seconds, but when the WebSocket reconnects (every 2s), it called `refreshAllLoadedThreads()` while the circuit breaker was still open — so all API requests failed immediately with "circuit open" and the data never loaded.
- **Fix applied:** Reset the circuit breaker when the WebSocket connects (`use-ws.ts:255`). This closes the circuit 2 seconds after server restart instead of 15.

**2. Second theory: Ghost processes holding the port**

The user suspected zombie processes. We checked with `netstat`:

```
TCP  127.0.0.1:3001  0.0.0.0:0  LISTENING  20148   ← live server
TCP  127.0.0.1:3001  0.0.0.0:0  LISTENING  29772   ← ghost (process dead!)
```

Two processes "listening" on the same port, but PID 29772 didn't exist anymore. Windows was keeping its TCP socket entries alive.

**3. Root cause: Vite proxy using dead connections**

Filtering the browser Network tab by Fetch/XHR revealed only 2 requests:
- `bootstrap` — stuck with "Provisional headers are shown" (never completed)
- `logs` — failed

The `/api/bootstrap` is the FIRST request the app makes at startup to get the auth token. If it hangs, `isLoading` stays `true` forever and the AuthGate component renders `<AppShellSkeleton />` indefinitely.

The Vite dev server proxy had established TCP connections to the old server process (PID 29772) before it died. Even though the process was dead, Vite kept trying to reuse those cached connections (HTTP keep-alive). Requests sent through the dead connection hung forever.

**4. Why `process.exit()` leaves orphans on Windows**

On Windows, `process.exit()` only terminates the current process. Child processes survive. The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) spawns Node.js subprocesses via `query()` with `executable: 'node'`. These subprocesses can inherit the server's socket handle (Windows handle inheritance via `bInheritHandles=TRUE` in CreateProcess). When the parent server dies, the orphaned subprocess keeps the port occupied.

### Solutions implemented

**A. Windows process tree kill on shutdown** (`index.ts` → ShutdownManager FINAL phase)

Before `process.exit()`, run `taskkill /F /T /PID` to kill the entire process tree including all child and grandchild processes. This prevents orphaned subprocesses from holding the port.

**B. Circuit breaker reset on WebSocket reconnect** (`use-ws.ts:255`)

When the WebSocket connects, call `useCircuitBreakerStore.getState().recordSuccess()` before `refreshAllLoadedThreads()`. This ensures API requests aren't blocked by the circuit breaker during reconnection.

**C. ShutdownManager registry pattern** (`shutdown-manager.ts`)

Centralized all scattered cleanup logic into a single registry. Before this, cleanup was manually orchestrated in `index.ts` with direct calls to each service. Adding or changing cleanup required editing multiple files.

**D. Fixed missing cleanup & timer leaks**

- `command-runner.ts` — active commands were NOT killed on shutdown (now they are)
- `rate-limit.ts` — `setInterval` for pruning was never cleared (timer leak)
- `mcp-oauth.ts` — `setInterval` for state cleanup was never cleared (timer leak)

**E. Persistent server logs** (`~/.funny/logs/server-YYYY-MM-DD.log`)

Added Winston file transport with daily rotation (7 day retention). Before this, all logs were console-only and lost on restart.

## Architecture: ShutdownManager

All cleanup is centralized in `packages/server/src/services/shutdown-manager.ts` using a registry pattern. Services self-register at import time.

### How it works

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

### Shutdown phases

```
Phase 0 (SERVER):    server.stop(true)         — release port first
Phase 1 (SERVICES):  [parallel] all services   — agents, PTY, scheduler, timers...
Phase 2 (DATABASE):  closeDatabase()           — last, because others write during cleanup
Phase 3 (FINAL):     taskkill /F /T + exit     — Windows tree kill, only on hard shutdown
```

### Registered services

| Service              | File                              | Phase    | Notes                              |
|----------------------|-----------------------------------|----------|------------------------------------|
| http-server          | index.ts                          | SERVER   | Releases port immediately          |
| observability        | index.ts                          | SERVICES | Flushes telemetry (hard only)      |
| automation-scheduler | automation-scheduler.ts           | SERVICES | Stops cron jobs + polling timer    |
| pty-manager          | pty-manager.ts                    | SERVICES | taskkill /F /T on Windows          |
| agent-runner         | agent-runner.ts                   | SERVICES | Mode-aware: extract vs kill        |
| command-runner       | command-runner.ts                 | SERVICES | Kills all running commands         |
| rate-limit-timer     | middleware/rate-limit.ts          | SERVICES | Clears prune interval              |
| mcp-oauth-timer      | mcp-oauth.ts                      | SERVICES | Clears state cleanup interval      |
| database             | db/index.ts                       | DATABASE | WAL checkpoint + close             |
| process-exit         | index.ts                          | FINAL    | Windows tree kill + process.exit   |

### Two shutdown modes

- **`hard`** (Ctrl+C / SIGINT): kills everything, exits process
- **`hotReload`** (bun --watch): preserves running agents on `globalThis`, kills the rest

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

# Kill a specific process tree
taskkill /F /T /PID <PID>

# Nuclear option: kill everything on port 3001
powershell -Command "Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
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

## Circuit breaker recovery

The client has a circuit breaker that blocks HTTP requests after 3 consecutive failures. When the WebSocket reconnects (every 2s), it automatically resets the circuit breaker (`use-ws.ts:255`), which also triggers `refreshAllLoadedThreads()` to reload all data.

If the UI is still stuck after the server is back:
1. Check browser Console for errors
2. Filter Network tab by Fetch/XHR — is `/api/bootstrap` completing?
3. Hard refresh: Ctrl+Shift+R

## Key files

| File | Role |
|------|------|
| `packages/server/src/services/shutdown-manager.ts` | Centralized shutdown registry |
| `packages/server/src/kill-port.ts` | Pre-startup ghost socket cleanup |
| `packages/server/src/dev-watch.ts` | Dev wrapper (runs kill-port + taskkill on exit) |
| `packages/client/src/hooks/use-ws.ts` | WebSocket reconnection + circuit breaker reset |
| `packages/client/src/stores/circuit-breaker-store.ts` | HTTP circuit breaker (opens after 3 failures) |
| `packages/client/src/stores/auth-store.ts` | Auth init (`_bootstrapPromise` at module load) |
| `packages/client/src/components/CircuitBreakerDialog.tsx` | Full-screen "server unavailable" overlay |
