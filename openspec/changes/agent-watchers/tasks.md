## 1. Data model & persistence (packages/shared)

- [x] 1.1 Add the `watchers` table (`id`, `threadId`, `userId`, `key`, `label`, `nextWakeAt`, `lastDelayMs`, `wakeCount`, `maxWakes`, `deadline`, `status`, `createdAt`, `updatedAt`) — added to `schema.sqlite.ts` + `schema.pg.ts` (single source of truth; server re-exports via `db/schema.ts`)
- [x] 1.2 Mirror the table in `src/db/schema.sqlite.ts` and `src/db/schema.pg.ts` (`nextWakeAt`/`deadline` as epoch-ms integers for the due-time scanner)
- [x] 1.3 Add raw-SQL creation for `watchers` — server migration `057_watchers` in `packages/server/src/db/migrate.ts`, with indexes on `(status, next_wake_at)`, `(thread_id, key)`, and `(user_id)`
- [x] 1.4 Add `createWatcherRepository(deps)` in `packages/shared/src/repositories/watcher-repository.ts`: insert, getById, getLiveByThreadKey, listPending, listDue(now), listByUser, update, deleteByThread (exported from `repositories/index.ts`)
- [x] 1.5 Add the shared `Watcher` type and `WatcherStatus` enum in `packages/shared/src/types.ts`
- [x] 1.6 Add `watcher:created` / `watcher:fired` / `watcher:rescheduled` / `watcher:completed` / `watcher:cancelled` to the `WSEvent` union in `types.ts` (the per-user broadcast event type, alongside `automation:*` — not the Socket.IO transport names in `socket-events.ts`)

## 1b. Persistence plumbing — runtime ⇄ server proxy (prerequisite for the engine)

The runner has no DB; the watcher-manager runs on the runner and proxies all
persistence to the server over the WS data channel. `list_due`/`list_pending`
are scoped to the runner's user server-side (runner-isolation boundary).

- [x] 1b.1 Add `IWatcherRepository` to `server-interfaces.ts` and `watchers: IWatcherRepository` to `RuntimeServiceProvider`
- [x] 1b.2 Add `data:watcher_*` event names to `RUNNER_DATA_EVENTS` in `socket-events.ts`
- [x] 1b.3 Add `remoteWatcher*` functions in `team-client.ts` (insert/get/getLiveByThreadKey/listPending/listDue/listByUser/update/deleteByThread)
- [x] 1b.4 Implement the `watchers` proxy in `runner-service-provider.ts` (delegates to the remote* functions)
- [x] 1b.5 Server `data-handler.ts`: `getWatcherRepo()` + switch cases + watcher tenant-ownership check (watcher.user_id == runnerUserId; list ops scoped to runnerUserId)
- [x] 1b.6 Scope `listPending(userId?)` / `listDue(now, userId?)` in the shared repository for per-user isolation

## 2. Watcher engine (packages/runtime)

- [x] 2.1 Created `src/services/agent-watcher-manager.ts` (named to avoid colliding with the git file-watchers in `git-watcher-service.ts`), delegating persistence to `getServices().watchers`
- [x] 2.2 `createOrReschedule(args)`: re-arms a live `(threadId, key)` keeping identity/`wakeCount`, else creates one. Clamps `delayMs` to `MIN_DELAY_MS` (60s); defaults `maxWakes` (20) / `deadline` (1h)
- [x] 2.3 Single heartbeat scanner (`setInterval`, 5s) with a re-entrancy guard → `listDueWatchers(now)` → `fire` each
- [x] 2.4 `startAgentWatchers()` = the rehydration (pending rows in the server DB are picked up on the next scan; no in-memory state). Started in `init-runtime.ts`; stop registered with `ShutdownManager` (SERVICES)
- [x] 2.5 Caps on fire: `wakeCount + 1 > maxWakes` or `now > deadline` → mark `expired`, emit `watcher:completed`, do NOT wake
- [x] 2.6 Emits `watcher:*` via `wsBroker.emitToUser` on create/fire/reschedule/expire/cancel (owning user only)
- [x] 2.7 `cancel(watcherId, userId)` ownership-checked → mark `cancelled`, emit `watcher:cancelled`
- [x] 2.8 Thread-delete cleanup is handled by the `thread_id ... ON DELETE CASCADE` FK (server deletes thread → watchers vanish); `removeThreadWatchers(threadId)` exported for any non-cascade path

## 3. Firing & agent wake (packages/runtime)

- [x] 3.1 On fire: increment + persist `wakeCount`, set `status = fired`, render the follow-up text (label + elapsed minutes + check count)
- [x] 3.2 Delivers the wake through `thread-service/messaging.ts` `sendMessage` (resumes the thread's existing session if idle)
- [x] 3.3 Idle-gating: `forceQueue: isAgentRunning(threadId)` — queues the wake when a turn is in flight (delivered after it completes, never interrupts), starts the agent when idle
- [x] 3.4 Reschedule path: a `funny_watch` call for an already-`fired` key re-arms it to `pending` via `createOrReschedule` (the `getLiveWatcherByThreadKey` lookup includes `fired`)

## 4. funny_watch tool & integration surface (packages/core + runtime)

- [x] 4.1 `funny_watch` tool in `agent-watch-tool.ts` (params: `key`, `label`, `delayMinutes`, optional `maxWakes`/`deadlineMinutes`) → single handler calls `agent-watcher-manager.createOrReschedule`, returns immediately. `alwaysLoad: true` + MCP `instructions` carry the "you MUST schedule" guidance at the tool layer
- [x] 4.2 In-process via `createSdkMcpServer` (server name `funny`), injected through `mcpServers` in `agent-lifecycle.ts` — the handler closes over the spawn's `threadId`/`thread.userId`
- [~] 4.3 DEFERRED: in-process SDK servers have no transport for a separate ACP process, so `toACPMcpServers` now SKIPS `type: 'sdk'` entries (was emitting a broken `command: ''` stdio). funny_watch is Claude-only for now; external-MCP funny_watch for ACP providers is a follow-up
- [x] 4.4 Injected on EVERY spawn (gated only on `thread.userId`, not user-configured); `mcp__funny__*` wildcard (sdk-claude.ts:312) auto-allows the tool

## 5. Scheduling reliability (packages/runtime)

- [x] 5.1 The "you MUST call funny_watch" guidance is carried as the in-process MCP server `instructions` block with `alwaysLoad: true` (surfaced to the model on every spawn) — see `agent-watch-tool.ts`. **This is now the SOLE reliability mechanism** (the MCP owns it).
- [~] 5.2–5.4 REMOVED by decision: the deterministic turn-completion nudge (`agentWatchReliabilityHandler` + `agent-watch-scheduled-tracker` + `detectDeferredCheckIntent`) was built, but the regex pre-filter fired too many false positives — notably on any message that _discusses_ watchers ("next wake in 4m", "re-check") — producing repeated unwanted re-prompts. Removed the handler, tracker, `markWatchScheduled` call, and its test. Rationale: the MCP `instructions`+`alwaysLoad` soft-nudge is enough; if the agent occasionally doesn't schedule, that's acceptable. A context-aware classifier (haiku) could revive a precise version later.

## 6. Global Watchers panel (packages/client)

- [x] 6.1 `stores/watcher-store.ts` (Zustand) keyed by id with `upsert`/`loadWatchers`/`cancelWatcher`; `watcher:*` cases wired into `ws-event-dispatch.ts` (switch + `ALL_EVENT_TYPES`) → `upsert(data.watcher)`
- [x] 6.2 `WatcherPanelButton.tsx` — global cross-thread Popover panel: per-watcher label, status Badge, live countdown to next wake (1s tick while open), wake count; `data-testid` on the trigger, panel, each row, and cancel. Mounted in `SidebarFooter`
- [x] 6.3 Cancel control → optimistic store update + `POST /api/watchers/:id/cancel`, rollback on failure
- [x] 6.4 Terminal outcomes surfaced distinctly: concluded / cancelled / "hit wake limit" (wakeCount ≥ maxWakes) / "timed out" (deadline) — both inferred from the single `expired` status
- [x] 6.x `NavItem` converted to `forwardRef` + prop spread so it works as a Radix `asChild` Popover trigger (additive; existing callers unaffected)
- [x] 6.5 Per-thread watcher clock across ALL surfaces: `ThreadWatcherIndicator.tsx` (amber `AlarmClock` + tooltip with count & next-wake countdown, renders null when no active watcher) injected once into `ThreadStatusPin` — the shared status-icon anchor used by sidebar `ThreadItem`, `KanbanCard`, and `VirtualThreadList`. Store populated app-wide via a mount-time `loadWatchers()` in `WatcherPanelButton` (+ live WS `watcher:*` updates). Shared `lib/watcher-utils.ts` (`formatCountdown`, `selectActiveWatchersForThread`)

## 7. Routing & proxy (packages/server + runtime)

- [x] 7.1 Server routes `GET /api/watchers` (list current user's, newest first) + `POST /api/watchers/:id/cancel` (ownership-checked by session `userId`) in `routes/watchers.ts`, mounted at `/api/watchers`
- [x] 7.2 N/A by design: watchers live in the server DB, so list/cancel are served DIRECTLY from the server (like automation CRUD) — no runner round-trip, robust to runner-offline. Isolation is the session `userId` DB filter. Cancel flips `status=cancelled`; the runner scanner only fires `pending` rows so it stops on its own

## 8. Tests

- [x] 8.1 Engine/repo (`watcher-repository.test.ts`, bun): `listDue` status+time selection, **catch-up** (overdue-by-many-intervals still due), `getLiveByThreadKey` live-vs-terminal, `listPending`, `update` (reschedule/expire), `deleteByThread` — 11 tests
- [x] 8.2 Idempotency (`agent-watcher-manager.test.ts`, vitest): first call creates one; same `(threadId, key)` re-arms keeping id + `wakeCount` (no duplicate); different key → separate; clamp to 60s min; default `maxWakes`/`deadline` — 5 tests
- [~] 8.3 Caps: repo test covers the EFFECT (`expired` → removed from `listDue`) and the engine test covers default cap assignment; the `fire()` cap-decision branch itself is internal (not driven by a test) — partial
- [ ] 8.4 DEFERRED: wake delivery idle/busy gating is internal to `fire()` (`forceQueue: isAgentRunning`); a full test needs a `fire` test seam
- [x] 8.5 Reliability (`agent-watch-reliability.test.ts`, vitest, 8 tests): `detectDeferredCheckIntent` flags deferred intent (EN+ES) and does NOT flag check-without-deferral / deferral-without-check / a plain conclusion (bounded false-positive); structured-signal tracker — `consumeWatchScheduled` true-once-then-false, `markWatchScheduled` clears a pending nudge, nudge-guard set/clear. The full handler dispatch path is not integration-tested
- [x] 8.6 Isolation: `listDue(now, userId)` / `listPending(userId)` scoping covered in `watcher-repository.test.ts` (user-1 vs user-2)
- [ ] 8.7 DEFERRED: client panel render/cancel test (needs a component render harness)

## 9. Verification

- [x] 9.1 `bun run typecheck` passes (baseline refreshed for the new bun-test file's expected `bun:test` resolution, matching existing repo tests) + client `bun run build` ✓ (`built in 3.10s`)
- [ ] 9.2 Manual smoke (requires running app — agent safety rules forbid starting dev servers headlessly): agent schedules a 1-minute snooze, turn ends, thread is woken on time, agent reschedules then concludes; panel shows countdown + wake count + final state. Left for an interactive run
