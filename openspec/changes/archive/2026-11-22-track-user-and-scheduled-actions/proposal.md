# Proposal

## Why

`track-funny-actions` recorded what funny does on its own to a workspace, a sandbox or a factory.
Three kinds of action are still silent, and in each one the user loses something without being
told:

- **Automations that never run.** An automation whose cron does not parse is saved anyway and never
  scheduled; only a log line says so (`automation-scheduler.ts` `schedule`). A tick skipped because
  the previous run is still running is also only logged (`fire`). The owner believes it runs.
- **GitHub writes from the review pane.** Merging a pull request (`POST /api/github/pr-merge`),
  publishing a repository (`POST /api/git/project/:id/publish`) and reverting a file in a pull
  request (`POST /api/github/pr-revert-file`) change GitHub and leave no trace in funny.
- **Destructive git commands the user runs.** Discarding changes, `reset --hard`, dropping a stash
  and rewinding a thread's code throw work away. Nothing records what was lost, and the user has no
  way back short of `git reflog`, which does not cover uncommitted changes at all.

Two paths of the previous change also have no test of their own: the branch checkout route's
stash, and the `checkout.switch` recorded when a local thread starts on another branch.

## What Changes

- **Automations:** the automation save (create and update) SHALL refuse a cron that does not parse.
  An automation stored with one before this change records a failed `automation.unscheduled`
  activity when the scheduler skips it. The first tick skipped in a streak (previous run still
  running) records an `automation.skipped` activity; later ticks of the same streak do not.
- **GitHub writes:** pull request merge, repository publish and file revert in a pull request are
  recorded as `github.write` activities, with what they changed as effects.
- **Destructive git commands with a way back:** discard, `reset --hard`, stash drop and code rewind
  first save an **undo snapshot** of what they are about to destroy (working tree with untracked
  files, index, `HEAD`, or the dropped stash) in a private git ref, reusing the snapshot code that
  rewind already has (`git-checkpoints.ts`). Each is recorded as a `git.destructive` activity that
  names the snapshot. The Activity tab offers **Restore** on such a row, which puts the snapshot
  back (after saving the current state as a new snapshot, so a restore can itself be undone).
  Snapshots older than 30 days are pruned.
- **New effects:** `repo-published`, `file-reverted`, `changes-discarded`, `commits-reset`,
  `stash-dropped`, `code-rewound`, `snapshot-saved`.
- **Tests:** the branch checkout route's stash handling and the `checkout.switch` recorded on local
  thread creation get route / service tests.

Out of scope: pipeline runs, single non-destructive git commands (stage, commit, soft reset,
checkout of a commit, cherry-pick), pull request comments and reactions, re-running CI jobs, and
undo for remote changes (a merged pull request or a published repository cannot be restored from a
local snapshot).

## Capabilities

### New Capabilities

- `git-undo-snapshots`: what funny saves before a destructive git command, where it is kept, how a
  user restores it, and when it is pruned.

### Modified Capabilities

- `background-activities`: the tracked operations gain automation skips and unscheduled
  automations, GitHub writes from the review pane and destructive git commands; an activity can
  offer Restore.
- `automation-execution`: an automation's schedule is validated when it is saved, and a schedule
  that is never run is reported to its owner.

## Impact

- **Shared:** new kinds and effects in `@funny/shared/activities`; `ActivityResultRef` gains
  `snapshot` (the ref name of an undo snapshot).
- **Server:** cron validation in `trpc/ports/automations.ts`; `automation.skipped` /
  `automation.unscheduled` from `automation-scheduler.ts` through `recordServerActivity`.
- **Runner:** `services/git-undo.ts` (snapshot save / restore / prune over `git-checkpoints.ts`);
  `recordActivity` at the destructive git routes (`routes/git/stage.ts`, `routes/git/stash.ts`,
  `routes/threads.ts` rewind) and the GitHub write routes (`routes/github/prs.ts`,
  `routes/github/pr-files.ts`, `routes/git/remote.ts`); a restore route.
- **Client:** Restore on Activity tab rows with a snapshot, retry targets for the new kinds, effect
  and badge strings (en, es, pt); automation form shows the cron error from the server.
- **No database migration:** the new fields live in the existing `input`, `effects` and
  `result_ref` JSON columns.
