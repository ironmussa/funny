# Proposal

## Why

funny does many things on its own that the user never sees: it removes worktrees and branches,
switches the branch of the user's checkout, stashes changes, stops agents, stops and destroys
sandboxes, merges pull requests from the issue factory. Only three operations are recorded as
activities today (clone, worktree setup, git workflow); the rest leave a log line at most, and a
failure is swallowed.

The case that started this: archiving a worktree thread shows "the branch and the worktree will be
removed", but nothing is removed. Archiving only sets a flag on the server, and deleting a thread
forwards a `DELETE /api/threads/:id` that the runner no longer serves, with the error ignored
(`packages/server/src/routes/threads.ts`). The cleanup code in
`packages/runtime/src/services/thread-service/update.ts` has no caller. Worktrees and branches of
archived and deleted threads pile up on disk, and nothing tells the user.

## What Changes

- **Fix thread cleanup.** Archiving or deleting a worktree thread removes its worktree and branch on
  the thread's runner, after stopping the commands and terminals running in it, as the dialog
  says. When the runner is offline the thread is still archived or deleted and the cleanup is
  recorded as failed.
- **One module for workspace removal on the runner.** Every place that removes a worktree or a
  branch (thread archive / delete, cleanup after a merge, the pipeline reviewer's worktree, the
  factory's cleanup after a merged PR, the worktree settings screen, orphan pruning) goes through
  it, so each one stops the running processes first and is recorded the same way.
- **Activities say who started them and what they changed.** An activity carries its origin (the
  user asked for it, it followed from another action, or funny did it on a schedule) and the list of
  things it removed or changed (worktree, branch, stopped commands, closed terminals).
- **Activities for instant actions.** An action that takes milliseconds is recorded in one write,
  already finished. A kind can be recorded only when it fails, so routine background work does not
  fill the panel.
- **Activities started by the server.** The server records its own actions: sandbox provisioning
  and the automatic sandbox lifecycle (stop when idle, wake, destroy), the factory's pull request
  merge and branch deletion, the factory disabling itself when the enabler loses access, and agents
  stopped because a project's runner binding changed.
- **New kinds on the runner:** workspace cleanup, orphan worktree pruning, and the changes funny
  makes to the user's own checkout (branch switch, automatic stash).
- **Panel:** an automatic activity is labelled as such, a destructive one is marked, and a finished
  one lists what it changed.
- **Guardrail:** a fitness check fails when runner or server code removes a worktree or branch
  outside the workspace module.

Not in this change: pipeline runs, automation skips, GitHub writes made from the review pane, git
operations the user runs one by one (reset, discard, stash drop) and the runner's housekeeping of
browser profiles and staged uploads. They follow once the model is in place.

## Capabilities

### New Capabilities

- `thread-workspace-cleanup`: what happens to a thread's worktree, branch and running processes
  when the thread is archived, deleted or merged, and what the user is told when it cannot be done.

### Modified Capabilities

- `background-activities`: the set of tracked operations grows to funny's own actions; activities
  gain an origin and a list of effects; instant and failure-only recording; activities run by the
  server; retry is offered only where there is a place to return to.

## Impact

- **Shared:** `activities/kinds.ts` (new kinds, per-kind `destructive` and recording policy),
  `Activity` type and contract (`origin`, `effects`), `activity-repository.ts` (server-run rows,
  one-write insert), `db/schema.*` + `db/migrate.ts` (two columns).
- **Runtime:** new workspace module over `@funny/core/git` worktree functions;
  `activity-tracker.ts` (`recordActivity`, origin, effects); `routes/worktrees.ts`,
  `git-service.ts`, `pipeline-manager.ts`, `thread-service/create.ts`, `routes/projects/git-routes.ts`
  call it; the dead cleanup in `thread-service/update.ts` is removed.
- **Server:** `activities/activity-service.ts` (server-run activities, restart reconciliation);
  thread archive (`trpc/ports/threads.ts`) and delete (`routes/threads.ts`) request the cleanup;
  `factory/factory-thread-requests.ts` shares that request; sandbox control, factory pull requests
  and `trpc/ports/project-runners.ts` record activities.
- **Client:** `data/activities/`, the Activity tab, `lib/activity-retry.ts`, locale files, the
  stale comment in `hooks/use-sidebar-actions.ts`.
- **Core:** `git/worktree.ts` branch deletion reports its failure.
- **Tooling:** new fitness check in `bun run lint`.
- **Protocol:** none. The activity payload is already a free-form struct on the data channel; the
  new fields are additive and an older peer ignores or refuses them without failing the operation.
- **Behaviour users will notice:** archiving and deleting worktree threads now frees disk space and
  deletes the thread's branch, which loses commits that were neither pushed nor merged (the dialog
  already warns about it).
