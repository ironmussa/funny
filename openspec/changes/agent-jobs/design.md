## Context

`agent-watchers` (shipped) gives agents a durable, funny-managed deferred wake ("snooze") and a per-thread clock. But it deliberately stayed **pure-snooze**: funny schedules _when_ to re-check; the agent launches and inspects the process itself. Production use surfaced the gap that decision left open: an agent's own background launch (`cmd &` via the Bash tool) lives in the agent/runner process subtree, and the harness reaps that subtree with SIGKILL after a few minutes — the work dies mid-flight. The only tell that it was killed-from-outside (vs finished) is the _absence_ of a manually-added `EXIT=$?` marker. Agents hand-roll `setsid` + `disown` + an exit-marker line to survive. This change makes funny own that launch as a reliable primitive.

It reuses the `agent-watchers` machinery wholesale: the `nextWakeAt` due-time scanner, `wsBroker.emitToUser`, the runtime→server data-channel proxy (`RuntimeServiceProvider` + `data:*` + `data-handler`), server-direct list/cancel routes, the global panel, and the `ThreadStatusPin` clock. The wake path is identical (`messaging.sendMessage` with idle-gating via `forceQueue: isAgentRunning`).

## Goals / Non-Goals

**Goals:**

- Make a background process launched by an agent survive turn-end, harness reaping, and runner restart.
- Encapsulate the `setsid` + logfile + exitfile pattern agents hand-roll today as one tool.
- Detect completion robustly and informatively — distinguish `exited(code)` from `killed` (externally SIGKILLed).
- Wake the agent when the job finishes, with the verdict and log tail.
- Reuse `agent-watchers` plumbing rather than duplicate it.

**Non-Goals:**

- A general container/cgroup sandbox or resource limits (the job runs under the runner user — same trust boundary as the existing Bash tool).
- Streaming live log tails over WebSocket (v1 surfaces a log path/handle; live streaming is a follow-up).
- Restarting/​supervising-forever (no auto-restart on crash; a job runs once to completion — `exited`/`failed`/`killed` are terminal).
- Cross-runner job migration.

## Decisions

### Decision 1: `funny_spawn` is always detached/durable — no fragile mode

The tool launches via `setsid` + a wrapper script and detaches stdio, reparenting the process to init. There is no "quick & dirty" path.

- **Why:** the user's directive — "siempre debería ser la opción más robusta". A fragile mode would just reproduce the reaping bug. One code path, always correct.
- **Mechanism:** write a wrapper that runs `<cmd> > <logPath> 2>&1; echo "EXIT=$?" > <exitPath>`, launch it with `setsid` and `child_process` `detached: true`, `stdio: 'ignore'` (the wrapper owns the redirects), then `.unref()`. Files live under `~/.funny/jobs/<jobId>/{log,exit}`.

### Decision 2: Detect status from exitfile + pid liveness, not a process handle

The scanner derives status by reading the exitfile and probing `kill -0 pid` — never by holding a child handle.

- **Why:** a detached/reparented process has no parent handle to await, and the runner may restart. Polling files + pid is the only restart-robust option, and it mirrors the watcher philosophy ("a poll re-derives ground truth").
- **State machine:**
  - exitfile present → `exited` (code 0) / `failed` (code ≠ 0)
  - no exitfile + `kill -0 pid` ok → `running`
  - no exitfile + pid dead → `killed` (terminated before recording an exit — the reaping case)
- **Consequence:** this is exactly the signal the user used to diagnose the reaping (the _missing_ `EXIT=` line). The exitfile is essential precisely because pid-liveness alone can't tell "finished cleanly" from "killed", and PIDs recycle.

### Decision 3: Reuse the watcher scanner; jobs are a sibling concept

`agent-job-manager.ts` is a sibling of `agent-watcher-manager.ts`. The existing 5s heartbeat gains a job-polling pass (`listRunningJobs` → evaluate → persist transitions → wake on terminal).

- **Why:** one heartbeat, one set of plumbing. Jobs and watchers are distinct (a job = a process; a watcher = a scheduled wake) so they get separate tables/managers, but they share the engine, the WS/proxy path, the panel, and the clock.
- **Alternative considered:** fold jobs into the `watchers` table with an optional process — rejected; the lifecycles and fields differ enough that a `jobs` table is clearer.

### Decision 4: funny detects completion and wakes (not pure-snooze)

Unlike watchers, jobs are not pure-snooze: funny owns the process, so it knows when it ends and wakes the agent with the verdict + log tail. `funny_spawn` may also take `wakeInMinutes` to additionally schedule a mid-run watcher.

- **Why:** the real use case is "tell me when it finishes." funny owns the exit signal, so making the agent poll for it would be wasteful. The wake reuses the watcher wake path verbatim.

### Decision 5: Cancel signals the process group

Cancel sends a termination signal to the job's process group (the `setsid` session), then marks `cancelled`.

- **Why:** a detached process isn't a child; you can't `.kill()` a handle. Signalling the session/process-group is how you actually stop it (and its descendants).

### Decision 6: A running job lights the per-thread clock

The client "active" notion is extended: the indicator lights for a running job OR a pending watcher. Terminal jobs don't light it.

- **Why:** a running job is the most literal "background process running" — exactly what the clock is meant to signal. It clears itself when the job exits (the scanner persists the terminal status → WS → store).

## Risks / Trade-offs

- **Truly orphaned/leaked processes** (job row lost but process alive, or vice versa) → status is always re-derived from pid+exitfile, and the jobs dir is the durable record; a `cancel` targets the process group. Stale job dirs can be GC'd by age (follow-up).
- **PID recycling** → never trust `kill -0` alone for "alive"; the exitfile is authoritative for "finished". Optionally also record the process start-time to harden liveness (follow-up if needed).
- **Disk growth from logfiles** → jobs dir under `~/.funny/jobs`; prune terminal jobs older than N days (follow-up).
- **Trust boundary** → jobs run arbitrary shell under the runner user, same as the existing Bash tool, but live longer. Documented; no new capability beyond what the agent already has. Cancel must reach the whole process group so a job can always be stopped.
- **Cross-user isolation** → jobs carry `userId`; WS via `emitToUser`, reads/cancel ownership-checked, `data:job_*` scoped to `runnerUserId` — same pattern as watchers.

## Migration Plan

Additive. Add the `jobs` table (sqlite + pg + server re-export) and a server migration; add `createJobRepository`; add `agent-job-manager.ts` and the scanner's job pass; add `funny_spawn` to the in-process MCP server; add `data:job_*` proxy + `data-handler` cases; add `GET /api/jobs` + cancel routes; extend the client store/panel/clock for jobs. No existing behavior changes; rollback is dropping the table + tool + service.

## Open Questions

- **Live log streaming**: v1 exposes a log path/handle and the wake carries a tail. Stream the log over WS to the panel later?
- **Default mid-run cadence**: should `funny_spawn` auto-schedule a watcher by default, or only when `wakeInMinutes` is given? (Leaning: only when given.)
- **Log/job-dir retention**: age-based prune policy and where to run it (scanner pass vs startup sweep).
- **Liveness hardening**: record process start-time alongside pid to fully defeat PID recycling — needed for v1 or follow-up?
