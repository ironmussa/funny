# Background activities

An **activity** is one run of an operation a user started that keeps going in the background:
cloning a repository (`project.clone`), setting up a thread's worktree (`worktree.setup`) and a
git workflow from the review pane (`git.workflow`: commit, push, create PR, merge). Activities are
stored on the server, so their outcome survives a reload, shows in every tab and stays until the
user clears it. Openspec change: `track-background-activities`.

Activities also record what funny does on its own (openspec `track-funny-actions`): cleaning up a
thread's workspace (`workspace.cleanup`, `workspace.prune`), switching the user's checkout
(`checkout.switch`), and actions the server takes: sandbox provisioning, stop, wake and destroy
(`sandbox.*`), factory merges, auto-disable and merge approvals the factory moved to another commit
(`factory.merge`, `factory.disabled`, `factory.approval-moved`) and agents
stopped by a runner binding change (`agents.stopped`).

- **Origin** (`origin` column, written once): `user` (asked for), `implicit` (followed from
  another action of the user, such as archiving) or `system` (a schedule or background check). The
  panel labels `implicit` and `system` rows "Automatic".
- **Effects** (`effects` column): what the operation removed, stopped or changed, as
  `{ effect, target }` from a closed list (`ACTIVITY_EFFECTS`), at most 20. A failed activity keeps
  the effects that happened before the failure. The reporter sends the whole list; it replaces the
  stored one.
- **Kind metadata** (static, in the registry): `destructive` (the panel marks the row) and
  `record`: `always`, or `on-failure` for routine actions (sandbox stop and wake) whose successful
  runs leave no row. A destructive kind always records.
- **Instant actions** are written in one step, already `succeeded` or `failed`
  (`recordActivity` on the runner, `recordServerActivity` on the server): `data:activity_start`
  with a final `status`. Later reports on such a row are refused.

## Flow

```
Runner (runs the operation)           Server (owns the rows)                Browser
trackActivity / beginActivity
  ├─ data:activity_start      ───▶  INSERT activities (running)    ───▶  activity:updated
  ├─ data:activity_update     ───▶  compare-and-set (step, status) ───▶  activity:updated
  ├─ activity:progress (%)    ─────────── relayed, not stored ─────────▶  activity:progress
  └─ data:activity_reconcile  ───▶  unlisted running rows → interrupted
     (on every (re)connect)
                                    tRPC activities.list / dismiss / clearFinished
                                                                    ───▶  activity:removed
```

- **Runner:** `packages/runtime/src/services/activity-tracker.ts`. Reports never block or fail the
  operation; the terminal report is retried with backoff (Effect) while the runner is disconnected.
- **Server:** `packages/server/src/services/activities/activity-service.ts` (data channel handlers,
  broadcasts), `trpc/ports/activities.ts` (list, dismiss, clear). The row's user and runner come
  from the runner session, never the payload; `data-scope.ts` and `data-ownership.ts` hold the
  rules (a projectless activity is general-runner work; an update must come from the row's runner).
- **Shared:** the machine `shared/src/activity-machine.ts`
  (`running → succeeded | failed | interrupted`, `interrupted → succeeded | failed`), the repository
  `shared/src/repositories/activity-repository.ts` (compare-and-set writes, cap of 500 rows per
  user that deletes only the oldest `succeeded` ones) and the kind registry
  `shared/src/activities/kinds.ts`.
- **Client:** the `data/activities/` collection and the Activity tab of the sidebar footer panel.

More kinds record what users do that cannot be taken back and what never happens (openspec
`track-user-and-scheduled-actions`): GitHub writes from the review pane (`github.write`: PR merge,
file revert in a PR, repository publish), destructive git commands (`git.destructive`: discard,
`reset --hard`, stash drop, rewind, and their restore), and automations that do not run
(`automation.unscheduled` for a stored schedule that does not parse — new ones are refused on save —
and `automation.skipped`, recorded once per run that is still running).

A review pipeline run started by a commit (`pipeline-manager.ts` `startPipelineRun`) is one
`pipeline.run` activity (openspec `track-pipeline-runs`): a step per stage, the fix commits as
`commit-created` effects, failed when cancelled. The git workflow's review-fix loop removes each
corrector's worktree once it has read its patch, as it does for the reviewer.

### Undo snapshots

Before a destructive git command the runner saves what it is about to remove
(`packages/runtime/src/services/git-undo.ts`, over the tree snapshot of `git-checkpoints.ts`):

- `refs/funny/undo/<activityId>` → a commit of the full working tree (untracked, non-ignored files
  included) whose parent is `HEAD`, or the stash commit about to be dropped;
  `refs/funny/undo/<activityId>-index` → the index tree.
- `runDestructive` saves first, refuses the command when the snapshot fails, and records one
  `git.destructive` activity with `resultRef.snapshot`. The routes call the wrappers in
  `services/git-destructive.ts`, never the git function directly.
- The Activity tab offers **Restore** on such a row (`canRestoreActivity`, 30 days). The runner
  route `POST /api/git/{project/:projectId | :threadId}/undo/:activityId` saves the current state
  as a new snapshot first, then puts the old one back; `404 snapshot-gone` once pruned, `409`
  while the thread's agent runs.
- Snapshots older than 30 days are pruned whenever a new one is saved. Rewind checkpoints
  (`git-checkpoints.ts`) are dated commits too and pruned the same way; a thread's workspace cleanup
  removes its checkpoints, including the undated ones saved before checkpoints had a date. `refs/funny/*` is not pushed
  with a branch; `git push --mirror` would push it (funny never runs it).

### Server-run activities

`packages/server/src/services/activities/server-activities.ts` (`trackServerActivity`,
`beginServerActivity`, `recordServerActivity`) writes rows with `runner_id` NULL over the same
repository and broadcast. The user is the one the action was taken for, read by the caller from
stored state (thread owner, sandbox row owner, factory enabler, project owner). An update with a
null runner compares `runner_id IS NULL`, so no runner report matches a server row. At start,
`hosts/bun/main.ts` calls `interruptServerActivities()` before the sandbox lifecycle and the
factory watcher start. A `running` server row cannot be dismissed. Assumes one server instance.

### Workspace cleanup

Every worktree or branch removal on the runner goes through
`packages/runtime/src/services/workspace-cleanup.ts` (`cleanupWorkspace`, `pruneOrphans`,
`removeScratchWorkspace`): validate the target against `git worktree list` (never the main
checkout), stop commands, close terminals, remove, record one activity with its reason and
effects. `scripts/fitness/check-workspace-removal.ts` fails on any other caller. Archiving or
deleting a thread asks the thread's runner for it from the server
(`server/services/thread-workspace-cleanup.ts`, `DELETE /api/worktrees` or
`DELETE /api/threads/:id/scratch`); when that runner cannot be reached the server records the
failed cleanup itself.

A runner that restarts reconnects with an empty list, so its running activities become
`interrupted`. A runner that never returns leaves its rows `running`; the panel shows them as
"runner offline" and lets the user dismiss them. Deleting a runner interrupts its rows.

## Adding a tracked operation

1. **Declare the kind** in `packages/shared/src/activities/kinds.ts`: its zod `input` schema,
   `destructive` and `record`. The server records only the declared fields, so never declare a
   secret.
2. **Wrap the call** on the runner with `trackActivity(spec, (activity) => run(activity))` for an
   operation that returns a `Result`, or `beginActivity(spec)` with `succeed` / `fail` when it ends
   elsewhere; use `recordActivity(spec, outcome)` for an action that completes at once. Set
   `origin` when the user did not ask for it. Report steps with `activity.step(label)`, percentages
   with `activity.progress(n)`, what it changed with `activity.effect(effect, target)` and what it
   produced with `activity.result({ projectId | prUrl })`. On the server use
   `trackServerActivity` / `recordServerActivity` the same way.
3. **Add the retry target** in `packages/client/src/lib/activity-retry.ts`: where retry takes the
   user (the form, prefilled from `input`, or the place the operation was started from). Retry never
   runs the operation by itself. A kind with nothing for the user to redo gets no entry.
4. **Add the effect labels** to the locale files (`activity.effects.*`) when you add an effect.
