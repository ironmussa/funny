# Design

## Context

See proposal.md for the motivation. `track-background-activities` (archived 2026-11-21) built the
model this change extends: the `activities` table, the machine in `shared/src/activity-machine.ts`,
the kind registry, the runner's `trackActivity` / `beginActivity`, the `data:activity_*` operations
and the Activity tab. Its design left two things for later that this change does: activities run by
the server (D1 there: "call the same repository directly") and more kinds.

Facts that shape the approach, read in the code:

- **Thread cleanup is dead.** `thread-service/update.ts` holds the cleanup for archive (stop
  commands, kill PTYs, remove worktree, remove branch) and delete, but the runner serves neither
  `PATCH /api/threads/:id` nor `DELETE /api/threads/:id`. Archive is the tRPC `threads.update` on
  the server (`trpc/ports/threads.ts`), which writes the flag only. Delete (`routes/threads.ts`)
  deletes the row, then forwards a DELETE the runner answers 404 to, ignored. The delete dialog's
  "also delete the branch" choice is dropped in `use-sidebar-actions.ts`.
- **The one working removal path** is the runner's `DELETE /api/worktrees`
  (`routes/worktrees.ts`), used by the worktree settings screen and by the factory's
  `cleanupFactoryWorktrees` (`factory-thread-requests.ts`), which already sends it to the thread's
  runner through `withRunnerFor` and clears `worktreePath` / `branch` on the row. That route does not
  stop commands or terminals.
- **Removal is called from five places** on the runner, each with its own subset of the steps:
  `routes/worktrees.ts`, `git-service.ts` (after a merge), `pipeline-manager.ts` (reviewer),
  `thread-service/update.ts` (dead), plus `pruneOrphanWorktrees` on every `GET /api/worktrees`.
- **`removeBranch` cannot fail.** `core/git/worktree.ts` runs `branch -D` with `reject: false` and
  discards the exit code, so every caller reports success.
- **The runner has no database**, and after a thread is deleted it cannot look the thread up. The
  server must send what to remove.
- **The activity payload is a `google.protobuf.Struct`** on the data channel (`ActivityStart`,
  `ActivityUpdate`), so new fields need no protocol change.
- **Activity writes are fenced by runner:** `repos.activities().update(id, patch, runnerId)`
  compares `runner_id`, and reconciliation and interruption are per runner. `runner_id` is already
  nullable for server rows, but nothing writes or reconciles such a row.
- The audit log (`server/src/lib/audit.ts`) writes log lines for operators. It is not stored per
  user and not shown, so activities do not duplicate it; an action may have both.

## Goals / Non-Goals

**Goals:**

- A worktree or branch is removed through one function on the runner, which stops processes,
  validates the target, removes, and records.
- The server can record an activity with the same repository, machine and broadcast as a runner.
- Adding a tracked action still costs a kind declaration and one call.
- Routine successes do not fill the panel or evict useful rows from the 500 cap.

**Non-Goals:**

- A hook in the generic git wrapper (`gitWrite` / `runTrackedWrite`). It sees every command but not
  why it ran: a `branch -D` after an archive and one after a merge look the same, and file removals
  done with `fs` bypass it.
- Parent / child activities. See D2.
- Tracking pipeline runs, automation skips, review-pane GitHub writes, single git commands the user
  runs (reset, discard, stash drop) and housekeeping of browser profiles and staged uploads.
- Undo. A removed worktree or branch is not restored; the dialog already says so.
- Changing when orphan directories are pruned. It stays on `GET /api/worktrees`; it becomes
  recorded.

## Decisions

### D1. Archive and delete remove the workspace, as the dialog says

Archiving a worktree thread removes the worktree and deletes the branch; deleting one removes the
worktree and deletes the branch only when the dialog's checkbox is set. This is what the dead code
did and what `dialog.worktreeWarning` promises.

Alternative considered: keep the worktree on archive and change the text. Rejected: archived threads
are the bulk of the leaked worktrees, the factory already removes them after a merge "as archiving
does", and unarchive never restored a worktree.

### D2. One activity per cleanup, with a reason and effects; no parent / child

A cleanup is one activity of kind `workspace.cleanup`. Its `input` carries the `reason`
(`thread-archived` | `thread-deleted` | `merged` | `factory-merged` | `review-finished` | `manual` |
`setup-undone`), the branch and whether the branch is deleted. What it did goes in a new
`effects` list on the row (D4).

Alternative considered: a `parentId` column and one child activity per step (stop commands, remove
worktree, delete branch). Rejected: it needs tree rendering, counters that skip children, and a rule
for a parent whose child failed, all to show three lines that fit in one row. Where two things are
separate operations (a git workflow that merges, then the cleanup), they are two activities on the
same thread, next to each other in the list.

### D3. Workspace module on the runner

New `runtime/src/services/workspace-cleanup.ts`, the only runner module that imports
`removeWorktree`, `removeBranch` and `pruneOrphanWorktrees` from `@funny/core/git`:

```text
cleanupWorkspace({ userId, projectId, projectPath, threadId?, worktreePath, branch?,
                   deleteBranch, reason, origin }) → ResultAsync<CleanupOutcome, DomainError>
pruneOrphans({ userId, projectId, projectPath }) → ResultAsync<number, DomainError>
```

`cleanupWorkspace` runs, in order, inside one `trackActivity`:

1. Refuse when `worktreePath` is the project path or is not listed by `git worktree list` for that
   project (on top of the existing `assertWorktreeInProjectBase`).
2. `stopCommandsByCwd`, `killPtysUnderPath`, `projectSearchRegistry.invalidate`.
3. `removeWorktree`.
4. `removeBranch` when `deleteBranch`.

Each completed step adds an effect. A failed step ends the activity `failed` with the effects so far
and returns the error; the branch step still runs when the worktree step succeeded.

Callers: `DELETE /api/worktrees` (`manual`, or the reason the server sends), `git-service.ts` merge
cleanup (`merged`), `pipeline-manager.ts` reviewer cleanup (`review-finished`), the rollback of a
failed thread worktree setup (`setup-undone`). The cleanup blocks in `thread-service/update.ts` are
deleted with their tests. `core/git/worktree.ts` keeps its own internal rollback.

`removeBranch` in core returns an error when `git branch -D` exits non-zero for a reason other than
"branch not found".

### D4. `origin` and `effects` on the row

Two columns on `activities`, both in `db/migrate.ts` for SQLite and PostgreSQL:

| Column    | Notes                                                                            |
| --------- | -------------------------------------------------------------------------------- |
| `origin`  | `user` \| `implicit` \| `system`. NOT NULL, default `user` (existing rows).      |
| `effects` | Nullable JSON array of `{ effect, target }`, at most 20, `target` capped at 512. |

`effect` is a closed enum in `@funny/shared/activities`: `worktree-removed`, `branch-deleted`,
`command-stopped`, `terminal-closed`, `directory-removed`, `branch-checked-out`, `changes-stashed`,
`sandbox-stopped`, `sandbox-destroyed`, `pr-merged`, `remote-branch-deleted`, `agent-stopped`,
`factory-disabled`. The server drops unknown effects and extra fields, as it does for `input`.

`origin` is written on insert only; `pickActivityPatch` never accepts it. `effects` is accepted on
`activity_update` together with the patch and replaces the stored list (the runner sends the full
list each time; the handle keeps it).

Alternative considered: put effects in `resultRef`. Rejected: `resultRef` is a reference to open
(a project, a PR URL), read by the retry and navigation code; effects are a log.

### D5. Kind metadata

Each entry of `ACTIVITY_KINDS` gains two static fields, read by the server and the client from the
registry and not stored:

- `destructive: boolean` — the panel marks the row.
- `record: 'always' | 'on-failure'` — an `on-failure` kind is recorded only through
  `recordActivity` (D6) and only when it failed. A destructive kind must be `always`; a unit test on
  the registry checks it.

New kinds:

| Kind                | Run by | Scope            | Destructive | Record     | Input                                          |
| ------------------- | ------ | ---------------- | ----------- | ---------- | ---------------------------------------------- |
| `workspace.cleanup` | runner | project, thread? | yes         | always     | `reason`, `branch?`, `deleteBranch`            |
| `workspace.prune`   | runner | project          | yes         | always     | —                                              |
| `checkout.switch`   | runner | project, thread? | no          | always     | `fromBranch?`, `toBranch`, `stashed`, `reason` |
| `sandbox.provision` | server | thread           | no          | always     | `provider`                                     |
| `sandbox.stop`      | server | thread           | no          | on-failure | `reason`                                       |
| `sandbox.wake`      | server | thread           | no          | on-failure | —                                              |
| `sandbox.destroy`   | server | thread?          | yes         | always     | `reason`                                       |
| `factory.merge`     | server | project, thread? | yes         | always     | `issueNumber`, `prNumber`                      |
| `factory.disabled`  | server | project          | no          | always     | `reason`                                       |
| `agents.stopped`    | server | project          | yes         | always     | `reason`                                       |

`workspace.prune` is recorded only when at least one directory was removed (the caller records after
the fact, D6). `checkout.switch` covers the three places funny changes the user's checkout: a local
thread created on another base branch (`thread-service/create.ts`), the branch checkout route's
automatic stash (`routes/projects/git-routes.ts`) and a merge that leaves the main checkout on the
target branch (`core/git/remote.ts`, recorded from `git-service.ts`).

### D6. `recordActivity`: one write for an instant action

`activity_start` accepts an optional final `status` (`succeeded` | `failed`) with `error`,
`effects` and `resultRef`. The server then inserts the row finished, with `ended_at = started_at`,
and broadcasts once. The runner helper:

```text
recordActivity(spec, outcome: { ok: true, effects?, resultRef? } | { ok: false, error, effects? })
```

For a kind declared `on-failure` it sends nothing when `ok`. It does not add the id to the live set,
and it uses the terminal retry (backoff while disconnected), since it is the only write.

Alternative considered: `beginActivity` followed at once by `succeed`. Rejected: two writes, two
broadcasts and a `running` flash in the panel for something that took ten milliseconds.

### D7. Server-run activities

New `server/src/services/activities/server-activities.ts`, the server's counterpart of the runner
tracker, over the same repository:

```text
trackServerActivity(spec, run) / beginServerActivity(spec) / recordServerActivity(spec, outcome)
```

`spec.userId` is supplied by the caller from stored state (thread owner, sandbox row owner, factory
enabler, project owner); these call sites already resolve it that way. Rows have `runner_id` NULL.

- Repository: `update(id, patch, runnerId)` with `runnerId = null` compares `runner_id IS NULL`, so
  a runner report can never match a server row and the server never touches a runner row.
  `data-ownership.ts` `checkActivity` already requires the row's runner to be the caller; a test
  pins the NULL case.
- Restart: `interruptServerActivities()` at boot (in `hosts/bun/main.ts`, before the sandbox
  lifecycle and the factory watcher start) sets every `running` row with `runner_id IS NULL` to
  `interrupted`. Sandbox provisioning is itself cancelled on shutdown and re-driven by the
  reconciler, which then records a new activity.
- Dismiss: `trpc/ports/activities.ts` refuses a `running` row without a runner (409).
- A write failure is logged and never fails the action, as on the runner.

Call sites, one each, at the choke points found in the inventory:

| Kind                                | Where                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `sandbox.provision`                 | `thread-sandbox-service.ts` `provision` (steps: create, install, connect, checkout)  |
| `sandbox.stop` / `wake` / `destroy` | a decorator over the `ThreadSandboxControl` object (`thread-sandbox-control.ts`)     |
| `factory.merge`                     | `factory-pull-requests.ts` `merge`; a swallowed branch-delete error becomes `failed` |
| `factory.disabled`                  | `factory-watcher.ts`, where `factory.disabled_access_lost` is audited                |
| `agents.stopped`                    | `trpc/ports/project-runners.ts` `stopProjectSessionsOnRunners`                       |

Alternative considered: have the server ask a runner to record for it. Rejected: a server action
often has no runner involved (a provider call, a GitHub call).

### D8. Server requests the thread cleanup

`cleanupFactoryWorktrees` is generalised into `server/src/services/thread-workspace-cleanup.ts`:

```text
requestThreadWorkspaceCleanup(ports, { userId, thread: { id, projectId, worktreePath, branch },
                                       deleteBranch, reason }) → Result<void, string>
```

It sends `DELETE /api/worktrees` to the thread's runner through `sendToThreadRunner`
(`withRunnerFor` + the certified sink, so the runner-isolation proofs are unchanged), with the
`reason` and `threadId` added to the body. The path and branch come from the server's own thread
row, never from the browser (`threadPatchBody` still has no `worktreePath`, security CR-4); the
runner re-validates the path (D3). The factory calls it with `factory-merged`.

- **Archive** (`trpc/ports/threads.ts` `update`, when `archived` goes false → true and the thread
  is a worktree thread, not sandbox, not external, not running): write the flag, answer, then run
  the cleanup in the background; on success clear `worktreePath` and `branch` on the row and
  broadcast the row.
- **Delete** (`routes/threads.ts`): read the row, delete it, answer, then run the cleanup with the
  values read. `deleteBranch` comes from a new optional field on the delete request (default false),
  which `use-sidebar-actions.ts` now passes from the dialog. The dead proxy of
  `DELETE /api/threads/:id` to the runner is removed. For a scratch thread the server sends a new
  runner route, `DELETE /api/threads/:id/scratch`, which removes `scratchPathFor(userId, threadId)`
  and records a `workspace.cleanup` with a `directory-removed` effect.
- **Runner unavailable** (`withRunnerFor` refuses, or the request fails before an answer): the
  server records the `workspace.cleanup` itself as a `failed` server activity whose error names the
  worktree path, and leaves the row's `worktreePath` / `branch` (archive). When the runner answered,
  the runner recorded the activity and the server records nothing.

Alternative considered: a durable queue that retries the cleanup when the runner returns. Rejected
for now: the failed activity plus the worktree settings screen (which lists and removes worktrees)
covers it; a queue is a second state machine to maintain.

### D9. Client

- `Activity` (shared type, contract schema) gains `origin` and `effects`; the collection and
  `apply-event.ts` need no change beyond the type.
- Activity tab row: an "Automatic" badge for `implicit` / `system`, a marker for destructive kinds
  (from the registry), and the effects as a short list under the title when the row is finished.
  shadcn `Badge`, theme colours, `data-testid` on the new elements.
- `lib/activity-retry.ts`: `workspace.cleanup` and `workspace.prune` open the project's worktree
  settings; `checkout.switch` and `sandbox.provision` open the thread, else the project. Server kinds
  without a target have no entry, and `canRetryActivity` already returns false for those.
- The failure toast stays as is: a failed implicit activity raises it, which is the point.
- Titles are written by the starter in English, as today. Effect labels and the badge are
  translated in the locale files (en, es, pt).
- The stale comment in `use-sidebar-actions.ts` is corrected.

### D10. Fitness check

`scripts/fitness/check-workspace-removal.ts`, added to `bun run lint`: fails on an import or call of
`removeWorktree`, `removeBranch` or `pruneOrphanWorktrees` in `packages/runtime/src` outside
`services/workspace-cleanup.ts`, and anywhere in `packages/server/src`. Tests are exempt.

## Risks / Trade-offs

- [Archive now deletes branches with unpushed commits] → It is what the dialog has always said;
  the release notes call it out. A thread that is running is not cleaned up on archive.
- [More rows against the 500 cap, which only evicts `succeeded`] → `on-failure` kinds, and
  `workspace.prune` recorded only when it removed something. Cleanup rows are bounded by the number
  of threads archived or deleted.
- [Server restart marks a long provisioning `interrupted` while the reconciler continues it] → The
  reconciler's run records a new activity; the interrupted one stays as history.
- [Several server instances: a restart of one would interrupt another's running rows] → The server
  already assumes one instance for the automation scheduler; documented here. A per-instance id on
  the row is the fix if that changes.
- [An old runner behind a new server] → `DELETE /api/worktrees` works as before without stopping
  processes or recording; the cleanup still happens. The server cannot tell, so no failed activity
  is recorded for it.
- [A new runner behind an old server] → New kinds and fields are refused or dropped; the tracker
  logs and the operation continues, as designed in `track-background-activities`.
- [The worktree path sent by the server is stale] → The runner refuses anything `git worktree list`
  does not name for that project; the activity fails with that reason.
- [`removeBranch` now fails where it silently succeeded] → Callers that treated it as best effort
  (`pipeline-manager.ts`, merge cleanup) go through the module, which records the failure and does
  not fail the surrounding operation.

## Migration Plan

1. Shared + server: columns, kind registry, server activities, the cleanup request. Old runners keep
   working.
2. Runner: workspace module, `recordActivity`, call sites, the scratch route.
3. Client: panel, retry targets, the delete request's `deleteBranch`.

Rollback: revert client and runner; revert the server's archive / delete cleanup call. The two
columns can stay unused.

Worktrees already leaked by archived and deleted threads are not removed by this change. Deleted
threads' worktrees appear in the worktree settings screen; archived threads still name theirs.

## Open Questions

- Should a one-off action offer to clean up the worktrees of threads archived before this change?
  It does not affect the model; it can be a follow-up once cleanup is recorded.
