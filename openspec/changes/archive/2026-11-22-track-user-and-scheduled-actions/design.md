# Design

## Context

See proposal.md for the motivation. `track-funny-actions` gave activities an `origin`, `effects`,
kind metadata (`destructive`, `record`), instant activities (`recordActivity` on the runner,
`recordServerActivity` on the server) and retry targets. This change adds kinds on top of that
model; it does not change the model's shape.

Facts read in the code:

- **Cron is not validated on save.** `@funny/shared/contracts/automations` checks only that
  `schedule` is a non-empty string. `automation-scheduler.ts` `schedule()` catches the croner error
  and logs `Invalid automation schedule — not scheduled`; the automation stays enabled and is never
  run. `fire()` logs `Automation tick skipped` when `hasRunInProgress(id)` is true.
- **GitHub writes are runner routes:** `POST /pr-merge` (`routes/github/prs.ts`), `POST
  /pr-revert-file` (`routes/github/pr-files.ts`, deletes the file on the head branch when it is
  new, else restores the base version) and `POST /api/git/project/:projectId/publish`
  (`routes/git/remote.ts`, `publishRepo`).
- **Destructive git routes:** discard (`POST /:threadId/revert` and `/project/:projectId/revert`,
  `revertFiles`, which also deletes untracked files), `reset-hard` (thread and project),
  `stash/drop/:stashIndex` (thread and project) in `routes/git/`, and `POST /api/threads/:id/rewind`
  (`thread-service/rewind.ts`, which restores a pre-turn checkpoint over the current files).
- **A snapshot mechanism exists.** `services/git-checkpoints.ts` captures the full working tree
  (untracked, non-ignored files included) through a temporary `GIT_INDEX_FILE` plus the real index
  as two trees under `refs/funny/codex-checkpoints/<thread>/<message>/{worktree,index}`, and
  restores them with `read-tree --reset` + `checkout-index --all --force`. It stores bare trees:
  no `HEAD`, no date.
- The runner has no database: it cannot look an activity up. The activity id is minted by the
  runner tracker when it records, so the runner can name a snapshot after it.

## Goals / Non-Goals

**Goals:**

- No automation silently never runs.
- Every GitHub write from the review pane and every destructive git command leaves an activity.
- Work thrown away by a destructive git command can be put back from the activity panel for 30
  days, including uncommitted and untracked changes.

**Non-Goals:**

- Undo of remote changes (a merged pull request, a published repository).
- Pipelines, stage / unstage, commit, soft reset, commit checkout, cherry-pick, PR comments and
  reactions, CI re-runs.
- Restoring onto a different repository or runner, or by a steer sharee.

## Decisions

### D1. Validate cron on save; report what is already stored

`trpc/ports/automations.ts` create and update parse `schedule` with the same croner call the
scheduler uses (`new Cron(schedule, { paused: true })`, wrapped in one helper
`parseAutomationSchedule` next to `createCronJob`) and answer `failure(400, <croner message>)`.
Validation lives in the server port, not the zod contract, because croner is a server dependency
and `@funny/shared` contracts stay browser-safe. The client form shows the server's message.

Rows stored before this change can still hold an invalid cron. `schedule()` records a failed
`automation.unscheduled` server activity (origin `system`, owner = the automation's `userId`) in
the catch branch. It runs once at boot and on every reschedule, so it is at most one row per
automation per boot or edit.

Alternative considered: a stored `scheduleError` field on the automation. Rejected: it needs a
migration and a second place to show it; the activity plus refusing new bad crons covers it.

### D2. One skip activity per long run

`fire()` keeps an in-memory `skippedRunIds: Map<automationId, runId>`. On a skip it looks up the
running run's id (the row `hasRunInProgress` already reads); if the map does not hold that run id
for the automation yet, it records `automation.skipped` (status `succeeded`, origin `system`, title
naming the automation, input `{ automationId, runningSince }`) and stores the run id. A tick that
starts a run clears the entry. A server restart forgets the map, which can add one more row for a
run that survives the restart; acceptable.

`automation.skipped` is recorded `succeeded`, not `failed`: a skip is the designed behavior, and a
`failed` row would raise the failure toast on every long run.

### D3. `github.write`: one kind, an `action` field

| `action`         | Route                               | Effects                               |
| ---------------- | ----------------------------------- | ------------------------------------- |
| `pr-merge`       | `POST /api/github/pr-merge`         | `pr-merged` (`owner/repo#n`)          |
| `pr-revert-file` | `POST /api/github/pr-revert-file`   | `file-reverted` (`path` on `headRef`) |
| `repo-publish`   | `POST /api/git/project/:id/publish` | `repo-published` (`owner/repo`)       |

Each route wraps its body in `trackActivity` (origin `user`, `destructive: true`, `record:
always`), with `resultRef.prUrl` set for the PR actions. Input: `action`, `prNumber?`, `filePath?`,
`repo?` (no token, no file content). Retry: `pr-merge` and `pr-revert-file` open the review pane on
the project's PRs tab; `repo-publish` opens the project.

Alternative considered: three kinds. Rejected: the retry target and the panel treatment are the
same; the action is already a field the title names.

### D4. Undo snapshots (`services/git-undo.ts`)

A generalization of `git-checkpoints.ts`, which both modules then share:

```text
saveUndoSnapshot({ cwd, activityId, kind: 'worktree' | 'stash', stashRef? })
  → ResultAsync<{ ref: string }, DomainError>
restoreUndoSnapshot({ cwd, activityId, restoreActivityId }) → ResultAsync<RestoreOutcome, DomainError>
pruneUndoSnapshots(cwd, maxAgeMs = 30 days) → ResultAsync<number, DomainError>
```

- **Worktree snapshot:** the existing capture (temporary index → worktree tree, real index → index
  tree), wrapped in a commit made with `commit-tree` whose parent is the current `HEAD` (none on an
  unborn branch) and whose message records `head <sha>`. Refs:
  `refs/funny/undo/<activityId>` → that commit, `refs/funny/undo/<activityId>-index` → the index
  tree. The commit gives the snapshot a date (for pruning) and keeps `HEAD` reachable after a
  reset.
- **Stash snapshot:** `refs/funny/undo/<activityId>` → the stash commit about to be dropped
  (`git rev-parse stash@{n}` before the drop).
- **Restore:** first `saveUndoSnapshot` of the current state under `restoreActivityId`, then for a
  worktree snapshot `read-tree --reset <tree>` + `checkout-index --all --force` + `read-tree --reset
  <index tree>` (the checkpoint restore), plus `reset --soft <head>` only when the snapshot's `head`
  is not the current `HEAD` (a reset hard moved it); for a stash snapshot `git stash store -m
  "funny: restored" <sha>`. It never touches a branch that is not checked out.
- **Prune:** `for-each-ref refs/funny/undo --format='%(refname) %(committerdate:unix)'` and
  `update-ref -d` on refs older than 30 days (and their `-index` sibling), called after each save.
  A stash ref's date is the stash commit's date.
- **Names:** `activityId` is validated against `^[A-Za-z0-9_-]{1,128}$` before it enters a ref
  name, as `checkpointRef` does.
- Refs under `refs/funny/` are not pushed by `git push` of a branch. `git push --mirror` would push
  them; funny never runs it. Documented.

Alternative considered: `git stash create` before the command. Rejected: it skips untracked files,
and `revertFiles` deletes them. Alternative considered: `git stash push -u` into the user's stash
list. Rejected: it changes the working tree before the command runs and fills the user's stash list
with funny entries.

### D5. `git.destructive`: snapshot first, then the command, then one record

| `action`     | Route(s)                                                | Snapshot | Effects                     |
| ------------ | ------------------------------------------------------- | -------- | --------------------------- |
| `discard`    | `POST /:threadId/revert`, `/project/:projectId/revert`  | worktree | `changes-discarded` × path  |
| `reset-hard` | `POST /:threadId/reset-hard`, `/project/:id/reset-hard` | worktree | `commits-reset` (old→new)   |
| `stash-drop` | `POST …/stash/drop/:stashIndex` (thread and project)    | stash    | `stash-dropped` (message)   |
| `rewind`     | `POST /api/threads/:id/rewind`                          | worktree | `code-rewound` (message id) |

One helper, `runDestructive(spec, cwd, snapshotKind, run)` in `services/git-undo.ts`:

1. mint the activity id (the tracker's `newId`) and `saveUndoSnapshot`; on failure return the
   error and do not run the command (spec: no snapshot, no command), recording a failed activity;
2. run the command;
3. `recordActivity` once, `succeeded` or `failed`, with effects, plus `snapshot-saved` and
   `resultRef.snapshot = <ref>`; on failure the snapshot is kept (the command may have partly run).

The routes call the helper instead of the git function. Origin `user`; `destructive: true`.

Forking a thread and rewinding the fork (`fork-and-rewind`) is not wrapped: the source thread's
files are shared with the fork and the restore writes the same worktree, so it is the same
`rewind` and goes through the same helper inside `forkAndRewind`.

### D6. Restore from the panel

- `ActivityResultRef` gains `snapshot?: string` (validated `^refs/funny/undo/[A-Za-z0-9_-]+$` by
  `resultRefOf` on the server).
- Runner route `POST /api/git/project/:projectId/undo/:activityId` (and `/:threadId/undo/:activityId`
  for a thread's worktree), resolving `cwd` with the existing `requireProjectCwd` /
  `requireThreadCwd`, which already check the caller owns the project / thread. It refuses a ref
  that does not exist (`404 snapshot-gone`), runs `restoreUndoSnapshot` and records a
  `git.destructive` activity with `action: 'restore'` and its own snapshot.
- Runner isolation already confines a restore to the activity owner's runner: the server proxy
  routes `/api/git/*` only to the caller's runner, and the route is not on the steer allow-list.
- Client: Activity tab rows with `resultRef.snapshot` and status `succeeded` show a **Restore**
  button (`data-testid="activity-item-restore-<id>"`), behind a confirm dialog that says the
  current state is saved first. A `404 snapshot-gone` answer hides the button for that row and
  shows a toast. The panel does not know the 30-day age on the runner; it offers restore on rows
  younger than 30 days and lets the runner answer.

### D7. Kinds

| Kind                     | Run by | Destructive | Record | Input                                                                          |
| ------------------------ | ------ | ----------- | ------ | ------------------------------------------------------------------------------ |
| `automation.unscheduled` | server | no          | always | `automationId`, `schedule`                                                     |
| `automation.skipped`     | server | no          | always | `automationId`, `runningSince`                                                 |
| `github.write`           | runner | yes         | always | `action`, `prNumber?`, `filePath?`, `repo?`                                    |
| `git.destructive`        | runner | yes         | always | `action`, `paths?` (≤ 50), `fromHead?`, `toHead?`, `stashIndex?`, `messageId?` |

New effects: `repo-published`, `file-reverted`, `changes-discarded`, `commits-reset`,
`stash-dropped`, `code-rewound`, `snapshot-saved`. The effects cap (20) applies: a discard of 300
files lists 19 paths plus `snapshot-saved`, and the title says the total.

### D8. Tests for the previous change's untested paths

- `routes/projects/git-routes.ts` checkout: a clean tree with strategy `stash` does not pop an
  older stash on a failed checkout and records no `changes-stashed`; a dirty tree records it.
- `thread-service/create.ts`: a local thread on another base branch records `checkout.switch` with
  `fromBranch` / `toBranch`; the same branch records nothing; a failed checkout records a failure.

## Risks / Trade-offs

- [Snapshots take disk space in large repositories] → They are git objects, deduplicated with the
  repository's own; only changed files add new blobs. Pruned after 30 days.
- [A snapshot step adds latency to discard / reset] → One `read-tree` + `add -A` into a temporary
  index + two `write-tree`; on a large untracked tree it can take seconds. Measured with a span
  (`git_undo.snapshot`); revisit if p95 is over a second.
- [Restore over a busy worktree (agent running)] → The route refuses while the thread's agent is
  running, as rewind already does.
- [Automation skip map is per instance] → The server assumes one instance for the scheduler
  already.
- [Old runner, new server / client] → An old runner's routes record nothing and its activities
  have no `snapshot`, so no Restore is offered. A new client calling restore on an old runner gets
  `404` and shows the toast.
- [`git push --mirror` would publish snapshots] → funny never runs it; documented in openwiki.

## Migration Plan

1. Shared: kinds, effects, `ActivityResultRef.snapshot`.
2. Server: cron validation, scheduler activities, `resultRefOf` accepts `snapshot`.
3. Runner: `git-undo.ts`, routes, restore route.
4. Client: Restore button, retry targets, strings.

Rollback: revert client and runner; the server changes are additive. Snapshot refs left in
repositories are harmless and can be removed with `git for-each-ref refs/funny/undo` +
`update-ref -d`.

## Open Questions

- Should rewind's own pre-turn checkpoints move under the same 30-day prune? They are never pruned
  today. Not needed for this change.
