# State machines

A lifecycle is a state machine whether or not the code says so: a `status` /
`state` / `phase` column, a cluster of booleans, or a nullable timestamp, plus
the code that changes it. This page says how this repository writes them down,
and lists the ones that are still implicit.

## The rule

1. **One table.** The states and the legal transitions live in one module, as an
   xstate machine in `packages/shared/src/` when more than one package needs it
   (`thread-machine.ts`, `sandbox-machine.ts`) or in the owning package
   otherwise (`packages/client/src/machines/`).
2. **The stored state is the only state.** A transition is computed from the
   state that was just read from where it is stored (the DB row, the collection
   row) by a pure function: `resolveThreadTransition(from, event)`,
   `nextSandboxState(from, event)`. Do not keep a long-lived actor as a second
   copy of a stored status; it drifts as soon as anything else writes the row.
   Actors are for state that lives only in memory (data loading, a terminal
   spawn, a debounce).
3. **Writes are compare-and-set.** A DB transition is
   `UPDATE … WHERE id = ? AND state IN (<legal from-states>)` with the row count
   checked, as `thread-sandbox-store.ts` `transition()` does. Reading the state,
   checking it in JS and then writing by id alone is a race.
4. **An event the state does not accept changes nothing**, and the caller can
   tell (`accepted: false`, `applied: false`). Do not overwrite the result.

## Explicit machines

| Machine          | Definition                                                 | Enforced by                                                                                                                                   |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread status    | `shared/src/thread-machine.ts`                             | `runtime/src/services/thread-status-machine.ts` (runner), `client/src/stores/thread-machine-bridge.ts` (client). See the gap below.           |
| Thread sandbox   | `shared/src/sandbox-machine.ts`                            | `server/src/services/thread-sandboxes/thread-sandbox-store.ts` (compare-and-set on every write)                                               |
| Factory run      | `orchestrator/src/domain/factory-run.ts`                   | `orchestrator/src/domain/state-machine.ts`, `run-recorder.ts`                                                                                 |
| Thread data load | `client/src/machines/thread-data-machine.ts`               | `client/src/stores/thread-machine-bridge.ts`                                                                                                  |
| Terminal spawn   | `client/src/machines/terminal-spawn-machine.ts`            | `client/src/components/TerminalPanel.tsx`                                                                                                     |
| History refresh  | `client/src/machines/history-refresh-machine.ts`           | `client/src/hooks/use-git-history-auto-refresh.ts`                                                                                            |
| Watcher          | `shared/src/watcher-machine.ts`                            | `shared/src/repositories/watcher-repository.ts` `update` (compare-and-set on every status write; the runner is told when a write was refused) |
| Background job   | `shared/src/job-machine.ts`                                | `shared/src/repositories/job-repository.ts` `update` (same)                                                                                   |
| Pending approval | `shared/src/repositories/pending-permission-repository.ts` | No table, but every write is a compare-and-set on `status = 'active'`                                                                         |
| Stage on start   | `runtime/src/services/thread-lifecycle-machine.ts`         | One rule (backlog / planning / review → in_progress when an agent starts)                                                                     |

## Implicit machines

Found by reading the code; "risk" is what the code allows, not a reproduced
failure unless it says so. Paths are under `packages/`. Ordered by value of
making each one explicit.

### Backend

| #   | Lifecycle                         | States                                                                                     | Where it is written                                                                                                                                                                                                                          | Risk                                                                                                                                                                                                        |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Thread status, around the machine | `ThreadStatus`                                                                             | `runtime/src/services/thread-service/{create,update,messaging,fork,rewind}.ts`, `ingest-mapper.ts`, `pipeline-adapter.ts`; `server/src/trpc/ports/threads.ts` `setStatus`; `server/src/services/data-handler.ts`, `data-message-handlers.ts` | About 30 writes set `threads.status` without asking the machine; `threads.setStatus` and the runner's `data:update_thread` store any status. Being observed, not enforced yet: see below.                   |
| 2   | Scheduler run                     | row exists / `nextRetryAtMs` null or set / `pipelineRunId`                                 | `scheduler/src/service.ts`, `shared/src/repositories/scheduler-run-repository.ts`                                                                                                                                                            | The state is still rebuilt from nullable columns on every tick, and there is no "gave up" state. (Fixed: a dispatched retry now leaves the retry queue, so it is no longer dispatched again on every tick.) |
| 5   | Runner presence and tasks         | `online, busy, offline`; task `pending, running, completed, failed`                        | `server/src/services/runner-manager.ts`, `grpc/runner-grpc-server.ts`                                                                                                                                                                        | `runners.status` has two writers (HTTP heartbeat, gRPC presence). Task claim and completion are compare-and-set, with no table.                                                                             |
| 6   | Thread stage                      | `ThreadStage`                                                                              | `server/src/trpc/ports/threads.ts`, `runtime/src/services/thread-service/{update,messaging}.ts`, `ingest-mapper.ts`                                                                                                                          | Ingest sets `review` over a user's `done`. Archiving sets the `archived` flag and emits stage `archived` without writing the stage column.                                                                  |
| 7   | Automation run                    | `running, completed, failed` (`archived` unused)                                           | `server/src/services/automation-scheduler.ts`, `automation-runs.ts`                                                                                                                                                                          | Both writers that leave `running` are compare-and-set (`finishRunningRun`, the stale sweep); there is no table.                                                                                             |
| 8   | Runner enrollment                 | `pending, approved, consumed`                                                              | `server/src/services/runner-enrollment-service.ts`                                                                                                                                                                                           | Both transitions are compare-and-set; there is no table.                                                                                                                                                    |
| 9   | Pipeline run                      | `PipelineRunStatus`                                                                        | `runtime/src/services/pipeline-manager.ts`                                                                                                                                                                                                   | The runner's `pipelines.createRun` returns `''` and `updateRun` does nothing, so runs are not stored and share one in-memory id. Fix persistence before modelling the states.                               |
| 10  | Agent process                     | sets and flags in `core/src/agents/orchestrator.ts`, `runtime/src/services/agent-state.ts` | `agent-message-handler.ts`, `agent-event-router.ts`                                                                                                                                                                                          | Six per-thread sets and maps that must agree, cleared at different points.                                                                                                                                  |

Known gaps in the guarded writers:

- **Watcher snoozed during a scan.** The fire is guarded on `pending` only, so a
  watcher re-armed between the scan and the fire (still `pending`, later
  `nextWakeAt`) is fired early. Closing it needs the expected `nextWakeAt` in
  the `watcher_update` operation of the runner protocol.
- **Status observer.** It reads the row's status before the write, outside it,
  so two concurrent writers can report a `from` that never happened. Expect a
  little noise in `thread.status_write_unmodelled`.

Small and already guarded (no action): MCP OAuth state, git workflow mutex, test
and command runners (keyed by run id), gRPC control negotiation, session
presence epochs.

### Client

| #   | Lifecycle                                                                         | Where                                                                                                                                    | Risk                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | Waiting card answer                                                               | `components/thread/MemoizedMessageList.renderers.tsx`, `use-thread-handlers.ts`, `tool-cards/`                                           | The card is marked answered before the send succeeds; a send in flight drops the answer; no failed / retry state.                                                                                                                                                                                                                                                                |
| 4   | Commit / push / PR / merge                                                        | `client/src/hooks/use-commit-workflow.ts`, `stores/commit-progress-store.ts`                                                             | Four in-progress booleans and a string, cleared by one watcher whose "previous entry" is not keyed by thread, so switching threads can read as "workflow finished". The `failed` event replaces the steps and removes the entry in one tick, so the watcher's failure branch (rebase-conflict detection, hook toast) only runs if a `step_update` carried the failed step first. |
| 5   | Main view and compose mode                                                        | `client/src/stores/ui-store.ts`                                                                                                          | Fifteen-odd flags meant to be exclusive, each opener clearing a different subset. One `mainView` union plus a compose union would replace them. (Selecting a thread now clears every compose flag.)                                                                                                                                                                              |
| 11  | Terminal tabs, clone view, runner enrollment dialog, extension draw / browse mode | `stores/terminal-store.ts`, `components/CloneRepoView.tsx`, `components/settings/RunnersSettings.tsx`, `chrome-extension/src/content.ts` | Local; boolean pairs that can both be set, or responses applied out of order.                                                                                                                                                                                                                                                                                                    |

### Fixed without a new machine

These were ordering or missing-compensation bugs in an existing lifecycle; each
has a regression test next to the code.

- A status still queued for the next frame no longer lands after a later
  `waiting` or `agent:error` for the same thread (`ws-event-dispatch.ts`).
- A send that started nothing (it failed, or was a shell escape) undoes its
  optimistic `running` (`revertOptimisticRun`, `stores/optimistic-run-state.ts`).
- Stopping dictation while it is still connecting cancels the start.
- A circuit-breaker probe that finishes after a request succeeded is ignored.
- A setup step that runs again after finishing is a new attempt.
- A step update from a previous git workflow run does not overwrite a new run's.
- A page-load session check that resolves after a login no longer undoes it.
- A browser panel's own close, answered after it reopened the thread's session,
  no longer marks the new session disconnected.

## Observing thread status writes (log-only)

Every thread status write on the server passes through the thread repository's
`updateThread`, which tells `server/src/services/thread-status-observer.ts` the
status the row had and the one written. A write the thread machine has no
transition for (`isThreadStatusWriteModelled` in `shared/src/thread-machine.ts`)
is counted as `thread.status_write_unmodelled` (attributes `from`, `to`) and the
first one of each pair per process is logged at `warn` (namespace
`thread-status`). Nothing is blocked.

To move to enforcing:

1. Let it run in production for a few days and group the metric by `from`/`to`.
2. For each pair, either add the transition to the machine (it is a real flow,
   such as rewind to `idle`) or fix the writer that should not make it.
3. When the metric stays at zero, make `updateThread` refuse unmodelled status
   writes (a compare-and-set on the legal from-states, as the watcher and job
   repositories do) and remove the observer.

## Enforced by lint

`bun run fitness:status-writers` (in `bun run lint`) fails when a guarded status
table is updated outside its owner: watchers, jobs, thread sandboxes, runner
enrollments and tasks, automation and scheduler runs, pending permission
requests. Add a table to `OWNERS` in `scripts/fitness/check-status-writers.ts`
when you give it a guarded writer.

## Adding or changing one

- New lifecycle: write the table first (rule 1), then the store write (rule 3).
  Test the table: every legal transition, and one illegal one per state.
- Existing implicit one: move its writes behind one function that takes the
  event, not the target status, before adding states.
- When the server sends a status the client's machine has no transition for,
  the fix is a transition in the shared machine, not an override at the call
  site.
