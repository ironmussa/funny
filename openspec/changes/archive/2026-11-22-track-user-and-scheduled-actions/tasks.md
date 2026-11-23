# Tasks

## 1. Shared model

- [x] 1.1 Declare the kinds `automation.unscheduled`, `automation.skipped`, `github.write` and `git.destructive` (design D7) with their input schemas, `destructive` and `record`; verify `activity-kinds.test.ts` covers each one's undeclared fields being dropped and `paths` being capped at 50
- [x] 1.2 Add the effects `repo-published`, `file-reverted`, `changes-discarded`, `commits-reset`, `stash-dropped`, `code-rewound` and `snapshot-saved` to `ActivityEffectType` and `ACTIVITY_EFFECTS`; verify `parseActivityEffects` keeps them
- [x] 1.3 Add `snapshot?: string` to `ActivityResultRef` and to the repository's stored `resultRef` schema; verify `activity-repository.test.ts` round-trips it

## 2. Server: automations

- [x] 2.1 Add `parseAutomationSchedule` next to `createCronJob` and refuse an invalid schedule with `400` in `trpc/ports/automations.ts` create and update (design D1); verify port tests cover an invalid create, an invalid update that leaves the stored schedule unchanged, and a valid schedule
- [x] 2.2 Record a failed `automation.unscheduled` server activity in `automation-scheduler.ts` `schedule()` when the stored schedule does not parse; verify a scheduler test with an injected `createJob` that throws records one activity for the owner
- [x] 2.3 Record `automation.skipped` once per running run in `fire()` (design D2); verify tests cover the first skip recorded, later skips of the same run not recorded, and a new run's skip recorded again
- [x] 2.4 Accept `snapshot` (only `refs/funny/undo/…`) in `resultRefOf` in `activity-service.ts`; verify `activities-data-channel.test.ts` covers a valid snapshot kept and any other value dropped
- [x] 2.5 Show the server's cron error in the automation form (client); verify a component test renders it

## 3. Runner: undo snapshots

- [x] 3.1 Extract the capture / restore steps of `git-checkpoints.ts` into helpers shared with a new `services/git-undo.ts`, keeping the checkpoint refs and behaviour unchanged; verify `git-checkpoints.test.ts` passes unchanged
- [x] 3.2 Implement `saveUndoSnapshot` (worktree and stash kinds), `restoreUndoSnapshot` and `pruneUndoSnapshots` (design D4) against a real temporary repository; verify tests cover tracked, staged and untracked changes surviving a discard-restore, `HEAD` coming back after a reset hard, a dropped stash coming back, the restore saving the current state first, a 31-day-old ref pruned, and an invalid activity id refused
- [x] 3.3 Implement `runDestructive` (design D5): snapshot first, refuse the command when the snapshot fails, one `recordActivity` with effects and `resultRef.snapshot`; verify unit tests cover success, a command failure keeping the snapshot, and a snapshot failure leaving the files untouched
- [x] 3.4 Route discard, `reset-hard` and stash drop (thread and project routes in `routes/git/stage.ts` and `routes/git/stash.ts`) through `runDestructive`; verify route tests show the activity input and effects for each and that the git function is not called when the snapshot fails
- [x] 3.5 Route `rewindCode` and `forkAndRewind` through `runDestructive` with action `rewind`; verify `rewind` tests show a snapshot of the pre-rewind files
- [x] 3.6 Add `POST /api/git/project/:projectId/undo/:activityId` and `POST /api/git/:threadId/undo/:activityId` (design D6): `404 snapshot-gone` for a missing ref, refuse while the thread's agent runs, record the restore with its own snapshot; verify route tests cover each case
- [x] 3.7 Record `github.write` for `pr-merge`, `pr-revert-file` and `repo-publish` (design D3) with `trackActivity`; verify route tests cover success and a GitHub refusal for each, and that no token appears in the recorded input

## 4. Client

- [x] 4.1 Add the Restore button with a confirm dialog on Activity tab rows that have `resultRef.snapshot`, are `succeeded` and are under 30 days old, calling the undo route through `lib/api`; hide it and toast on `404 snapshot-gone` (design D6); verify `ActivityList.test.tsx` covers shown / hidden and a story covers a discard row
- [x] 4.2 Add retry targets for `automation.unscheduled` (the project's automation settings), `github.write` (`pr-merge` / `pr-revert-file`: the review pane's PRs tab; `repo-publish`: the project), and none for `automation.skipped` and `git.destructive`; verify `activity-retry.test.ts` covers each
- [x] 4.3 Add en / es / pt strings for the new effects, the Restore button and its dialog; verify the locale files hold the same keys

## 5. Tests for the previous change

- [x] 5.1 Branch checkout route: a clean tree with strategy `stash` neither pops an older stash on a failed checkout nor records `changes-stashed`; a dirty tree does both correctly (design D8); verify the test fails on a version that pops unconditionally
- [x] 5.2 Local thread creation on another base branch records `checkout.switch` with the branches; the same branch records nothing; a failed checkout records a failure

## 6. Integration

- [x] 6.1 Update `openwiki/architecture/background-activities.md` (new kinds, undo snapshots, Restore, the `--mirror` note) and `CLAUDE.md` where it lists what activities record; verify every file named exists
- [x] 6.2 Run `bun run lint`, `bun run typecheck`, each affected package's `test` script and React Doctor on the changed client lines; verify all pass
- [x] 6.3 Run `bunx fallow audit --base master`; verify the verdict is not `fail`
