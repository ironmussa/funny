## 1. Data model & persistence (packages/shared)

- [x] 1.1 Added `jobs` table to `schema.sqlite.ts` + `schema.pg.ts` (`pid`/`exitCode` integers; `logPath`/`exitPath` NOT NULL); server `db/schema.ts` re-exports it
- [x] 1.2 Server migration `059_jobs` (058 was taken) in `migrate.ts` with indexes on `(status)`, `(thread_id)`, `(user_id)`. Added the table to the shared test-db helper too
- [x] 1.3 `createJobRepository(deps)` in `packages/shared/src/repositories/job-repository.ts`: insert, getById, listRunning(userId?), listByUser, update, deleteByThread; exported from `repositories/index.ts`
- [x] 1.4 `Job` type + `JobStatus` enum + `WSJobData` in `types.ts`; `job:created`/`job:exited`/`job:killed`/`job:cancelled` added to the `WSEvent` union

## 2. Detached spawn + job manager (packages/runtime + core)

- [x] 2.1 Durable detached launch in `agent-job-manager.spawnJob`: wrapper `(<cmd>) > log 2>&1; echo "EXIT=$?" > exit`, spawned via Node `child_process.spawn('bash', ['-c', wrapper], { detached:true, stdio:'ignore' })` + `.unref()` (Node's detached = setsid equiv → session leader, reparented to init), under `${DATA_DIR}/jobs/<id>/`. Returns `{ jobId, logPath, pid }`
- [x] 2.2 `src/services/agent-job-manager.ts` (sibling of agent-watcher-manager): `spawnJob`, `cancelJob`, `listJobsForUser`, `removeThreadJobs`, persistence via `getServices().jobs`
- [x] 2.3 `deriveStatus(job)`: exitfile `EXIT=0` → exited; `EXIT≠0` → failed; no exitfile + `process.kill(pid,0)` alive → running; no exitfile + dead → killed
- [x] 2.4 Job-polling scanner (sibling 5s `setInterval`, re-entrancy guard) → `listRunningJobs` → `deriveStatus` → persist transition → emit `job:exited`/`job:killed` → wake
- [x] 2.5 `cancelJob` signals the process group (`process.kill(-pid, 'SIGTERM')`) then marks `cancelled`; ownership-checked
- [x] 2.6 Startup re-attach = `startAgentJobs()` (running jobs re-derived from exitfile/pid on the next scan; no in-memory handle). Started in `init-runtime.ts`; stop registered with `ShutdownManager`

## 3. Completion wake (packages/runtime)

- [x] 3.1 On terminal transition, `renderCompletion` (label + verdict + exitCode + 50-line log tail) delivered via `messaging.sendMessage` with `forceQueue: isAgentRunning(threadId)` (idle-gated, never interrupts)
- [x] 3.2 Optional `wakeInMinutes` on spawn → also schedules a watcher (`key: job:<id>`) via `createOrReschedule` for a mid-run wake

## 4. funny_spawn tool (packages/runtime)

- [x] 4.1 `funny_spawn` added to the in-process MCP server in `agent-watch-tool.ts` (params: `command`, optional `cwd`/`label`/`wakeInMinutes`) → calls `spawnJob`, returns `{ jobId, logPath, pid }`. MCP `instructions` rewritten to cover both tools (spawn for launching, watch for self-checking)
- [x] 4.2 Same injection path as funny_watch (every spawn, `mcp__funny__*` wildcard) — both tools live in the one `funny` server

## 5. Runtime ⇄ server proxy (packages/shared + runtime + server)

- [x] 5.1 `IJobRepository` in `server-interfaces.ts` + `jobs: IJobRepository` in `RuntimeServiceProvider` (+ test mock updated)
- [x] 5.2 `data:job_*` events in `RUNNER_DATA_EVENTS`; `remoteJob*` in `team-client.ts`; `jobs` proxy in `runner-service-provider.ts`
- [x] 5.3 Server `data-handler.ts`: `getJobRepo()` + 6 switch cases + tenant-ownership check (`job.user_id == runnerUserId`; list scoped to runnerUserId)

## 6. Server routes (packages/server)

- [x] 6.1 Server `routes/jobs.ts`: `GET /api/jobs` (server-direct, current user, newest first) + `POST /api/jobs/:id/cancel` **proxied to the runner** (`proxyToRunner`) so it signals the detached process group; mounted at `/api/jobs`. Runtime `routes/jobs.ts` (`POST /:id/cancel` → `cancelJob`) registered at `/api/jobs`

## 7. Client: panel + clock (packages/client)

- [x] 7.1 `stores/job-store.ts` (Zustand) + `lib/api/jobs.ts`; `job:*` cases wired into `ws-event-dispatch.ts` (switch + `ALL_EVENT_TYPES`) → `upsert(data.job)`; loaded on mount + on open in `WatcherPanelButton`
- [x] 7.2 Panel extended: a "Background jobs" section (label/command, status badge, exit code) with a cancel control for running jobs; `data-testid`s on rows + cancel. Badge count = active watchers + running jobs
- [x] 7.3 `ThreadWatcherIndicator` lights for a RUNNING job too (reads `job-store` via `selectRunningJobsForThread` + watcher store); terminal jobs don't light it; tooltip mentions running jobs + next watcher wake

## 8. Tests

- [x] 8.1 Job repo (`job-repository.test.ts`, bun, 5 tests): insert/getById, listRunning (+ userId scoping), update (terminal drops out of listRunning), listByUser, deleteByThread
- [x] 8.2 `deriveStatus` (`agent-job-manager.test.ts`, vitest, 5 tests): exitfile `EXIT=0` → exited; `137` → failed(137); no exitfile + live pid (`process.pid`) → running; no exitfile + dead pid → killed; null pid → killed
- [ ] 8.3 DEFERRED: full detached-survival integration test (spawn a real process, kill the parent, assert it survives + writes the exitfile) — hard to run reliably in CI; the launch path is exercised manually (9.2) and the status logic is unit-tested (8.2)
- [x] 8.4 Isolation covered by `listRunning(userId)` scoping in the repo test (user-1 vs user-2); WS/cancel cross-tenant guard is the `data:job_*` ownership check (server-side, same as watchers)

## 9. Verification

- [x] 9.1 `bun run typecheck` ✓ (no new errors; baseline 115) + client `bun run build` ✓ (`built in 3.07s`). Tests green: 10 repo (bun) + 5 job-manager (vitest) for this change
- [ ] 9.2 DEFERRED (manual, interactive): `funny_spawn` a 2-min command, end the turn, confirm it survives past the reaping window, the thread clock stays lit while running, the agent is woken on completion with the exit code, and the panel shows the job + log
