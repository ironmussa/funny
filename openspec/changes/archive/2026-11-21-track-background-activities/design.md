# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- The runner has no database. It persists through the gRPC data channel (`data:*` operations in
  `protocol/runner/v2/operations.proto`), and every data type needs a scope rule
  (`DATA_SCOPE_RULES` in `server/services/data-scope.ts`) and an ownership check
  (`server/services/data-ownership.ts`).
- Jobs already follow the pattern this change needs: a table, a machine in
  `shared/src/job-machine.ts`, a compare-and-set repository, `data:job_insert` / `data:job_update`,
  a tRPC list, and a collection in `client/src/data/background/`.
- Runner → browser events (`wsBroker.emitToUser`) reach the server as `userEvent` and are relayed
  with `relayToUser`. That path is best effort: a dropped event is not retried.
- "Operation" already names a runner gRPC call (`services/grpc/operations-handler.ts`,
  `operation-idempotency.ts`), so the new concept is called **Activity**.
- Jobs and watchers belong to a thread and are deleted with it. A clone has neither a thread nor,
  until it succeeds, a project.

## Goals / Non-Goals

**Goals:**

- Adding a tracked operation costs one kind declaration and one wrapper call, with no new event
  type, table or listener.
- The outcome of an activity is recorded even if no browser is connected when it ends.
- The stored status is the only copy; every write is a compare-and-set
  (`docs/architecture/state-machines.md`).

**Non-Goals:**

- Folding jobs, watchers, pipelines, automation runs or factory runs into the model.
- Cancelling an activity. The tracked operations have no cancel today; a `cancelled` status is
  added with the first operation that supports it.
- Replacing `clone:progress`, `worktree:setup` and `git:workflow_progress`. They keep feeding
  `CloneRepoView`, the thread view and the review pane. Activities are added next to them.
- Storing logs. The error message is stored; full output stays in the runner's logs.

## Decisions

### D1. The executor reports through the data channel; the server does not translate old events

The runner reports an activity with three new data operations, modelled on the job ones:

| Operation                 | Does                                                 |
| ------------------------- | ---------------------------------------------------- |
| `data:activity_start`     | Inserts the row (`running`).                         |
| `data:activity_update`    | Compare-and-set of status, step, error, `resultRef`. |
| `data:activity_reconcile` | The runner lists its live activity ids (see D4).     |

After each accepted write the server broadcasts `activity:updated` (the full row) to the user.
Server-run operations, added in a later change, call the same repository directly.

Alternative considered: keep the three existing events and have the server derive activities from
them. Rejected: the relay is best effort, so a lost terminal event would leave a row `running`; and
each new operation would need a translator on the server besides its runner code.

Alternative considered: one generic `operation:update` realtime event that the client folds into a
local list. Rejected by the persistence requirement (answer 1 of the exploration).

### D2. Data model

Table `activities` (SQLite + PostgreSQL, created in `db/migrate.ts`):

| Column                    | Notes                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `id`                      | Chosen by the starter, so a client-picked id (clone) can be reused.   |
| `user_id`                 | From the runner session's owner, never from the payload.              |
| `runner_id`               | From the runner session. Nullable for server-run activities.          |
| `kind`                    | A key of the kind registry (D3).                                      |
| `project_id`, `thread_id` | Nullable, no foreign key: the row must outlive its thread or project. |
| `title`                   | Display text, written by the starter.                                 |
| `status`                  | `running` \| `succeeded` \| `failed` \| `interrupted`.                |
| `step`                    | Nullable label of the current step.                                   |
| `error`                   | Nullable message.                                                     |
| `input`                   | JSON, validated and stripped by the kind's schema (D3).               |
| `result_ref`              | Nullable JSON (`{ projectId }`, `{ prUrl }`).                         |
| `started_at`, `ended_at`  |                                                                       |

Index on `(user_id, started_at)` for the list and on `(runner_id, status)` for reconciliation.

Machine in `shared/src/activity-machine.ts`, the same shape as `job-machine.ts`:

```
running     → succeeded | failed | interrupted
interrupted → succeeded | failed
```

`shared/src/repositories/activity-repository.ts` writes with
`UPDATE … WHERE id = ? AND status IN (legal from-states)` and returns whether a row changed; the
runner is told when a write was refused, as for jobs.

### D3. Kind registry in `@funny/shared`

`shared/src/activities/kinds.ts` maps each kind to a zod schema of its `input`:

| Kind             | Scope            | Input                                                       | `resultRef`     |
| ---------------- | ---------------- | ----------------------------------------------------------- | --------------- |
| `project.clone`  | none             | `cloneUrl` (credentials removed), `destinationPath`, `name` | `{ projectId }` |
| `worktree.setup` | project + thread | `branch`, `baseBranch`                                      | none            |
| `git.workflow`   | project + thread | `action`                                                    | `{ prUrl? }`    |

The server parses `input` with the kind's schema on `activity_start`; zod's default object parsing
drops undeclared fields, which is what keeps a stray token out of the row. `cloneUrl` goes through
one shared `stripUrlCredentials` function before it is recorded. An unknown kind is refused. The
module is browser-safe, so the client uses the same schemas to read `input` when it refills a form.

Alternative considered: a free-form `input` blob. Rejected: nothing would stop a caller from
recording a secret, and the retry code would read untyped data.

### D4. `interrupted` comes from reconciliation on connect, not from disconnect

On every (re)connect the runner sends `data:activity_reconcile` with the ids it is still running.
The server sets `interrupted` on that runner's `running` rows that are not in the list.

- A restarted runner has an empty list, so all its rows become `interrupted`.
- A connection blip does not change anything: the operation is still in the list.

Marking rows on disconnect was rejected for that second case: the WebSocket carrier can drop while
`git clone` continues, and the row would flip to `interrupted` and back.

A runner that never returns leaves its rows `running`. The panel shows such a row as "runner
offline" (from runner presence, which the client already has) and lets the user dismiss it (D6).
Deleting a runner through `runner-manager` marks its `running` rows `interrupted`.

`interrupted → succeeded | failed` exists for one race: the runner reconnects and reconciles before
its in-memory tracker has registered an operation that is starting. The late terminal report then
still lands.

### D5. Scope and ownership on the data channel

- `activity_start`: scope rule by reference. With a `threadId`, the thread rule; with only a
  `projectId`, `canRunnerAccessProject`; with neither, `canRunnerServeProjectless`. The handler
  overwrites `userId` and `runnerId` from the session.
- `activity_update`: the ownership check loads the row and requires `row.runnerId` to be the
  calling runner.
- `activity_reconcile`: only touches rows whose `runner_id` is the calling runner.

No new rule is derived at a call site; the three types get entries in `DATA_SCOPE_RULES` and
`data-ownership.ts` like the job types.

### D6. Reads and user writes over tRPC

New `activities` group in `@funny/api`, port in `server/src/trpc/ports/activities.ts`:

- `list` — the caller's rows, newest first.
- `dismiss({ id })` — deletes a non-`running` row. A `running` row is deleted only when its runner
  is not connected; otherwise 409.
- `clearFinished` — deletes the caller's non-`running` rows.

Both writes broadcast `activity:removed` (ids) to the user, so other tabs follow. Add the group to
`MIGRATED_GROUPS`.

### D7. Progress is transient

A step change is an `activity_update` and is persisted. A percentage is not: the runner emits
`activity:progress` (`{ id, percent }`) through `emitToUser`, the existing best-effort path, and the
client keeps it in memory next to the row. Persisting every tick of a clone would be a write per
progress line for a value nobody needs after the operation ends.

### D8. Runner helper

`runtime/src/services/activity-tracker.ts` exposes one function:

```text
trackActivity({ id?, kind, userId, projectId?, threadId?, title, input }, (activity) => ResultAsync<T, E>)
```

It sends `activity_start`, runs the callback, and sends the terminal `activity_update` from the
callback's `Result` (`err` → `failed` with the error message; a thrown exception too). The callback
receives `activity.step(label)`, `activity.progress(percent)` and `activity.result(ref)`. The
tracker keeps the set of live ids for D4.

A failed report must not fail the operation: the tracker logs it and continues. The terminal report
is retried with backoff (Effect, per `AGENTS.md`) while the runner is disconnected, because it is
the one write that must land.

Wrapped call sites: the background clone in `runtime/src/routes/github/repos.ts` (reusing the
client-chosen `cloneId` as the activity id), the worktree setup in
`runtime/src/services/thread-service/` and `git-workflow-service.ts`.

### D9. Cap at 500

After an accepted `activity_start`, the repository deletes the user's oldest `succeeded` rows
beyond 500 total, in the same transaction. `failed`, `interrupted` and `running` rows are never
picked, so a user with more than 500 of those keeps them all.

### D10. Client

- `client/src/data/activities/`: collection (`store.ts`), `loaders.ts`, `hooks.ts`, `read.ts`,
  `actions.ts` (dismiss and clear are optimistic), `apply-event.ts` for `activity:updated` /
  `activity:removed` / `activity:progress`, `testing.ts`. `data/resync.ts` reloads the list on
  reconnect.
- `components/sidebar/WatcherPanelButton.tsx` becomes `ActivityPanelButton`: the same popover with
  shadcn `Tabs` (Activity, Jobs, Watchers). The jobs and watchers lists move into their tabs
  unchanged.
- Retry is a client registry, `lib/activity-retry.ts`: kind → a function that navigates. Clone
  opens `CloneRepoView` with the input as initial values; `worktree.setup` and `git.workflow` open
  the thread (`getThreadRoute`), the latter with the review pane, falling back to the project when
  the thread is gone.
- The failure toast is raised where `activity:updated` is applied, when a row's status changes to
  `failed` (not on the initial list load).

## Risks / Trade-offs

- [A runner from before this change reports nothing] → The panel is empty for its operations and
  the in-context views keep working, since the old events are untouched. No version gate is needed.
- [A terminal report is lost while the runner is disconnected for good] → The row stays `running`,
  shown as "runner offline", and the user can dismiss it. Reconciliation fixes it if the runner
  returns.
- [Two sources for the same progress (old events and activities) can disagree] → Accepted for this
  change. The in-context views stay on the old events; a later change moves them to activities and
  retires the events.
- [Proto change] → Additive fields only; `bun run protocol:breaking` and the golden fixtures guard
  it, and the Rust protocol crate is regenerated in the same task.
- [`title` and `error` are runner-written text shown to the user] → Rendered as plain text, length
  capped by the contract schema.
- [The retry form can be stale: the destination directory of a failed clone may now exist] → The
  form validates as it does for a fresh attempt; retry starts nothing by itself.

## Migration Plan

1. Ship the server first (table, data operations, tRPC, realtime). Old runners keep working.
2. Ship the runner (tracker and wrapped call sites). A new runner against an old server gets its
   reports refused as unknown data types; the tracker logs and the operation continues.
3. Ship the client with the panel.

Rollback: revert the client and runner; the table can stay, unused.
