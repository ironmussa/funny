## Why

When an agent launches a long-running process from its Bash tool (`some-command &`), that process lives inside the agent/runner process tree. The harness reaps the background subtree after a few minutes with SIGKILL, so the process dies even though its work isn't done — and the only signal that it was killed-from-outside (rather than finished) is the _absence_ of an exit marker the agent had to hand-roll. Agents currently work around this with `setsid` + `disown` + a manual `EXIT=$?` log line. funny should own this as a reliable primitive: launch the process **detached and durable**, track it, and wake the agent when it actually finishes. This complements `agent-watchers` (which schedules _when_ to re-check) by making the _launch itself_ survive.

## What Changes

- Introduce a **job**: a funny-owned, detached background process. An agent starts one via a new `funny_spawn` tool.
- **`funny_spawn` is always robust — there is no fragile mode.** It launches the command via `setsid` + a wrapper that redirects stdout/stderr to a logfile and writes `EXIT=$?` to an exitfile on completion, fully detached (stdio closed, `disown`/`unref`), so it is reparented to init (PID 1) and survives **turn end, harness reaping, and runner restart**.
- funny **owns and tracks** the job (a new `jobs` table). `funny_spawn` returns `{ jobId, logPath, pid }` immediately so the agent's turn can end.
- **funny detects completion** (it is not pure-snooze for jobs — the use case is "tell me when it finishes"). The existing watcher scanner polls each running job using BOTH signals:
  - the **exitfile** → terminated, with the exact exit code (durable, survives restart);
  - **`kill -0 pid`** → liveness.
    This distinguishes `exited` (clean, with code), `failed` (non-zero), `running`, and `killed` (pid gone but no exit marker — externally SIGKILLed, the reaping case).
- On a transition to a terminal status, funny **wakes the agent** (reusing the watcher wake plumbing: a follow-up via `messaging` + session resume, gated on thread-idle) with the log tail and the verdict.
- `funny_spawn` optionally auto-schedules a watcher (`wakeInMinutes`) so the agent can also poll mid-run, not only on completion.
- **Detection is stateless / restart-robust**: status is re-derived from the exitfile + pid by `jobId`, so a runner restart re-attaches without losing track.
- **UI**: the per-thread clock indicator lights up for a **running job** (not just a pending watcher); the global panel lists jobs (command, status, exit code, log). Cancel = signal the process group + mark cancelled.
- **Reuses almost all `agent-watchers` machinery**: the `nextWakeAt`/due-time scanner, `wsBroker` per-user events, the runtime→server data-channel proxy, server-direct list/cancel routes, the global panel, and the `ThreadStatusPin` clock.

## Capabilities

### New Capabilities

- `agent-jobs`: the `funny_spawn` tool and the durable detached-launch primitive (setsid + wrapper + logfile + exitfile, reparented to init); the `jobs` persistence model and runtime→server proxy; restart-robust status detection (exitfile + pid liveness) via the shared scanner; the global panel rows and the running-job clock; server-direct list/cancel routes.
- `agent-job-completion-wake`: detecting a job's terminal transition and waking the agent with the log tail + verdict, reusing the thread wake/idle-gating plumbing; optional `wakeInMinutes` auto-watch.

### Modified Capabilities

<!-- None as a delta spec: `agent-watchers` is still an in-flight change (not an
archived spec), so the clock/indicator extension ("a running job also lights the
indicator") is captured as an ADDED requirement under `agent-jobs` instead of a
delta. The shared scanner gaining a job-polling pass is likewise part of
`agent-jobs`. -->

## Impact

- **New DB table** `jobs`: `id`, `threadId`, `userId`, `command`, `cwd`, `pid`, `logPath`, `exitPath`, `label`, `status` (`running|exited|failed|killed|cancelled`), `exitCode`, `startedAt`, `updatedAt`. Schema in `packages/shared/src/db/schema.{sqlite,pg}.ts` (+ server `db/schema.ts` re-export), created via a new server migration. New `createJobRepository(deps)` in `packages/shared/src/repositories/`.
- **New runtime service** `agent-job-manager.ts` (spawn + tracking + status polling + completion wake), a sibling of `agent-watcher-manager.ts`. The detached spawn uses `setsid`/detached `child_process` under a funny-managed jobs dir (e.g. `~/.funny/jobs/<id>/{log,exit}`). The scanner (existing 5s heartbeat) gains a job-polling pass.
- **New agent tool** `funny_spawn` added to the in-process MCP server in `agent-watch-tool.ts` (alongside `funny_watch`), handler calling `agent-job-manager.spawn`.
- **Reuses**: `execute`/process utilities from `@funny/core`, `wsBroker.emitToUser`, `messaging.ts` + `sdk-session.ts` for the wake, `nanoid`.
- **New WS events** `job:created` / `job:exited` / `job:killed` / `job:cancelled` in the `WSEvent` union; consumed by `ws-event-dispatch.ts` and a job slice (or folded into the watcher store).
- **New runtime→server proxy** `data:job_*` events (`RUNNER_DATA_EVENTS`), `remoteJob*` in `team-client.ts`, `jobs` proxy in `runner-service-provider.ts`, and `data-handler.ts` cases + tenant-ownership check (`job.user_id == runnerUserId`).
- **New server routes** `GET /api/jobs` + `POST /api/jobs/:id/cancel` (server-direct, ownership by session userId), mounted at `/api/jobs`.
- **Client UI**: extend the global Watchers panel (or a sibling) to show jobs, and extend `selectActiveWatchersForThread` / the clock so a running job lights the indicator.
- **Trust boundary**: jobs run shell commands on the runner under the runner's user — same trust boundary as the agent's existing Bash tool (no new exposure), but now surviving longer; cancel must signal the **process group** (the setsid session) to actually stop a detached job.
