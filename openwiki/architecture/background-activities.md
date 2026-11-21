# Background activities

An **activity** is one run of an operation a user started that keeps going in the background:
cloning a repository (`project.clone`), setting up a thread's worktree (`worktree.setup`) and a
git workflow from the review pane (`git.workflow`: commit, push, create PR, merge). Activities are
stored on the server, so their outcome survives a reload, shows in every tab and stays until the
user clears it. Openspec change: `track-background-activities`.

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

A runner that restarts reconnects with an empty list, so its running activities become
`interrupted`. A runner that never returns leaves its rows `running`; the panel shows them as
"runner offline" and lets the user dismiss them. Deleting a runner interrupts its rows.

## Adding a tracked operation

1. **Declare the kind** in `packages/shared/src/activities/kinds.ts`: its zod `input` schema. The
   server records only the declared fields, so never declare a secret.
2. **Wrap the call** on the runner with `trackActivity(spec, (activity) => run(activity))` for an
   operation that returns a `Result`, or `beginActivity(spec)` with `succeed` / `fail` when it ends
   elsewhere. Report steps with `activity.step(label)`, percentages with `activity.progress(n)` and
   what it produced with `activity.result({ projectId | prUrl })`.
3. **Add the retry target** in `packages/client/src/lib/activity-retry.ts`: where retry takes the
   user (the form, prefilled from `input`, or the place the operation was started from). Retry never
   runs the operation by itself.
