# Proposal

## Why

Operations the user starts and that run in the background (cloning a repository, setting up a
worktree, commit / push / create PR) report their progress only to the view that started them, and
nothing records the outcome. If the user navigates away, reloads or opens another tab, a clone that
failed leaves no trace: there is no place to see that it ran, why it failed, or to try again.

Each operation also reports in its own shape (`clone:progress`, `worktree:setup`,
`git:workflow_progress`), so every new background operation needs its own event, its own listener
and its own UI.

## What Changes

- Add an **Activity**: one persisted record per user-started background operation, with a status
  (`running`, `succeeded`, `failed`, `interrupted`), the current step, the error, the input it was
  started with and a reference to its result. The server stores it; the runner (or the server, for
  server-run operations) reports it through one generic contract.
- Add an **Activity panel** in the sidebar footer. The existing jobs / watchers button becomes one
  entry point with three tabs: Activity, Jobs, Watchers. The button shows how many activities are
  running and how many failed ones the user has not dismissed.
- Show a toast when an activity fails, with a link to the panel.
- Activities stay until the user clears them: dismiss one, or clear all finished ones. One safety
  cap: beyond 500 activities per user, the oldest succeeded ones are deleted. Failed and interrupted
  ones are never deleted automatically.
- "Retry" reopens the form the activity was started from, filled with its original input. For an
  operation without a form (push, create PR), it opens the place it was started from (the thread's
  review pane).
- An activity whose runner stopped before reporting an outcome becomes `interrupted` instead of
  staying `running` forever.
- First operations tracked: **clone repository**, **worktree setup**, **git workflow** (commit /
  push / create PR / merge from the review pane).
- Jobs and watchers keep their own tables, events and actions. They share the panel, not the model.

Not in this change: sandbox launch, thread / worktree deletion, convert-to-worktree, fork,
pull / fetch, add local project (a follow-up change adds them as new kinds); cancelling an activity
from the panel; retiring the existing `clone:progress`, `worktree:setup` and
`git:workflow_progress` events, which keep feeding their in-context views.

## Capabilities

### New Capabilities

- `background-activities`: recording user-started background operations, their status lifecycle,
  who can see them, how long they are kept, and how the user sees, dismisses and retries them.

### Modified Capabilities

None.

## Impact

- **Database:** new `activities` table (SQLite and PostgreSQL), created by `db/migrate.ts`.
- **Runner protocol (`protocol/runner/v2/operations.proto`):** new data operations for reporting
  activities. Additive; a runner from before this change reports none.
- **`packages/shared`:** activity types, status machine, kind registry, repository, tRPC contract
  schemas, new realtime event types.
- **`packages/server`:** data-channel handlers with scope and ownership rules, reconciliation when
  a runner connects, the `activities` tRPC group, realtime broadcast.
- **`packages/api`:** `activities` router.
- **`packages/runtime`:** a tracking helper, wrapped around clone, worktree setup and the git
  workflow service; a report of live activities on connect.
- **`packages/client`:** `data/activities/`, the panel in the sidebar footer (the
  `WatcherPanelButton` grows tabs), failure toast, retry navigation, translations (en / es / pt).
- **Docs:** `docs/architecture/state-machines.md` (new explicit machine), `CLAUDE.md` data-layer
  folder list and tRPC group list, openwiki.
