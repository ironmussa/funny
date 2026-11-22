# Tasks

## 1. Shared model: origin, effects, kind metadata

- [x] 1.1 Add the `origin` (NOT NULL, default `user`) and `effects` (nullable JSON) columns to `activities` in `shared/src/db/schema.sqlite.ts`, `schema.pg.ts` and `db/migrate.ts`; verify `activities-migration.test.ts` covers a database created before the change (existing rows read as `origin: 'user'`, `effects: null`)
- [x] 1.2 Add `ActivityOrigin`, `ActivityEffect` (closed `effect` enum + `target`) and the two fields to `Activity` in `shared/src/types.ts` and to the contract schema in `shared/src/contracts/activities.ts`; verify `bun run typecheck` passes
- [x] 1.3 Add `destructive` and `record` to every entry of `ACTIVITY_KINDS` and declare the new kinds of design D5 with their input schemas; verify `activity-kinds.test.ts` checks that a destructive kind records `always`, that an unknown kind is refused and that undeclared input fields are dropped for each new kind
- [x] 1.4 Add `parseActivityEffects` (drops unknown effects and extra fields, caps the list at 20 and `target` at 512) to `@funny/shared/activities`; verify unit tests cover the cap and an unknown effect
- [x] 1.5 Extend `activity-repository.ts`: `insert` accepts `origin`, `effects` and an optional final status with `error` / `resultRef` / `endedAt`; `update` accepts `effects` and compares `runner_id IS NULL` when called with a null runner; add `interruptServerActivities()`; verify `activity-repository.test.ts` covers a one-write finished insert, a refused update after it, the NULL-runner fence in both directions and the server interruption

## 2. Server: activity service and server-run activities

- [x] 2.1 In `activity-service.ts`, accept `origin`, `effects` and a final `status` on `data:activity_start` and `effects` on `data:activity_update`, never accepting `origin` in a patch; verify `activities-data-channel.test.ts` covers an instant activity (one broadcast, already final), an update that tries to change `origin`, and effects replaced on update
- [x] 2.2 Implement `server/src/services/activities/server-activities.ts` (`trackServerActivity`, `beginServerActivity`, `recordServerActivity`; `on-failure` kinds record nothing on success; a write failure is logged and does not fail the action); verify unit tests cover ok, err, throw, the `on-failure` policy and a failing repository
- [x] 2.3 Call `interruptServerActivities()` at boot in `hosts/bun/main.ts` before the sandbox lifecycle and factory watcher start; verify a test shows a `running` row without a runner becoming `interrupted` and a runner's row left alone
- [x] 2.4 Make `trpc/ports/activities.ts` `dismiss` refuse a `running` row without a runner (409) and pin in `data-ownership` tests that a runner cannot update a row without a runner; verify `activities-port.test.ts` and the ownership test cover both
- [x] 2.5 Update `openwiki/architecture/background-activities.md` with origin, effects, instant recording, the recording policy and the server-run flow; verify the "Adding a tracked operation" steps match the code written in groups 1 and 2

## 3. Runner: tracker and workspace module

- [x] 3.1 Extend `activity-tracker.ts`: `origin` on `ActivitySpec`, `activity.effect(effect, target)` on the handle (sent with the next update and with the terminal report), and `recordActivity(spec, outcome)` as one retried write that skips successful `on-failure` kinds and does not join the live set; verify `activity-tracker.test.ts` covers each
- [x] 3.2 Make `removeBranch` in `core/src/git/worktree.ts` return an error when `git branch -D` exits non-zero for a reason other than a missing branch; verify a core test covers a deleted branch, a missing branch (ok) and a refused deletion (err)
- [x] 3.3 Implement `runtime/src/services/workspace-cleanup.ts` (`cleanupWorkspace`, `pruneOrphans`) per design D3: target validation against `git worktree list` and the main checkout, stop commands, kill PTYs, invalidate the search index, remove worktree, delete branch, effects per step, one `workspace.cleanup` activity; verify tests cover the happy path, a refused target (nothing removed), a failed branch deletion (activity `failed` with the worktree effect) and that processes are stopped before the removal
- [x] 3.4 Route `DELETE /api/worktrees` through `cleanupWorkspace`, accepting the optional `reason` and `threadId` in `deleteWorktreeSchema` (default reason `manual`, origin `user`; any other reason is origin `implicit`), and `GET /api/worktrees` through `pruneOrphans`, recording `workspace.prune` only when a directory was removed; verify route tests cover both and that a GET that prunes nothing records nothing
- [x] 3.5 Route the merge cleanup in `git-service.ts` (`merged`), the reviewer cleanup in `pipeline-manager.ts` (`review-finished`) and the rollback of a failed thread worktree setup (`setup-undone`) through `cleanupWorkspace`; verify `git-workflow-activity.test.ts` and the pipeline tests show a cleanup activity next to the workflow's and that a cleanup failure does not fail the merge
- [x] 3.6 Delete the unreachable archive and delete cleanup blocks from `thread-service/update.ts` with their tests, after confirming with `fallow dead-code --trace` that nothing reaches them; verify `bun run typecheck` and the runtime tests pass
- [x] 3.7 Add `DELETE /api/threads/:id/scratch` on the runner, removing `scratchPathFor(userId, threadId)` and recording a `workspace.cleanup` with a `directory-removed` effect; verify a route test covers the removal and a refusal for a thread id of another user
- [x] 3.8 Add `scripts/fitness/check-workspace-removal.ts` to `bun run lint` (design D10) and document it in `scripts/fitness/README.md`; verify it fails on a fixture that calls `removeWorktree` from a route and passes on the repository

## 4. Server: archive and delete request the cleanup

- [x] 4.1 Generalise `cleanupFactoryWorktrees` into `server/src/services/thread-workspace-cleanup.ts` (`requestThreadWorkspaceCleanup`, design D8), keeping the factory's selection of threads as its caller with reason `factory-merged`; verify the existing factory cleanup tests pass against it and a test shows the request goes only to the thread's runner
- [x] 4.2 On archive in `trpc/ports/threads.ts`, start the cleanup in the background for an idle, non-sandbox, non-external worktree thread, then clear `worktreePath` / `branch` and broadcast the row on success; verify tests cover a worktree thread, a local thread (no request), a running thread (no request) and a failed removal (row keeps its worktree)
- [x] 4.3 On delete in `routes/threads.ts`, read the row, delete it, answer, then request the cleanup with `deleteBranch` from a new optional field of the delete request (schema in `@funny/shared/contracts/threads`), remove the dead proxy of `DELETE /api/threads/:id`, and send the scratch route for a scratch thread; verify tests cover delete with and without the branch, a scratch thread and that the answer does not wait for the runner
- [x] 4.4 When the runner is unavailable or the request fails before an answer, record a `failed` `workspace.cleanup` server activity naming the worktree path, and record nothing when the runner answered; verify tests cover runner offline on archive and on delete, and that no other runner of the user is asked
- [x] 4.5 Add a regression test for the original bug: archiving a worktree thread end to end (server port with a fake runner port) results in one `DELETE /api/worktrees` request for that thread's worktree and branch; verify it fails on the code before 4.2

## 5. Runner: changes to the user's checkout

- [x] 5.1 Record `checkout.switch` (origin `implicit`, effects `branch-checked-out` and `changes-stashed`) where a local thread is created on another base branch (`thread-service/create.ts`) and where the branch checkout route stashes automatically (`routes/projects/git-routes.ts`), including a failed `stash pop`; verify tests cover a switch, a switch with a stash, and no activity when the branch does not change
- [x] 5.2 Record `checkout.switch` from `git-service.ts` when a merge leaves the main checkout on the target branch; verify a test covers it and that a merge performed in a worktree that leaves the main checkout alone records none

## 6. Server-run kinds

- [x] 6.1 Track `sandbox.provision` in `thread-sandbox-service.ts` `provision` with a step per phase, for the thread owner; verify tests cover success, a failure with its step and the failure reached through `POST /api/infra/threads/:id/sandbox`
- [x] 6.2 Decorate `ThreadSandboxControl` to record `sandbox.stop` and `sandbox.wake` on failure only and `sandbox.destroy` always (reason: idle, thread deleted, reconciled, released), for the sandbox row's owner; verify tests cover an idle stop that succeeds (no row), a failed wake and a destroy
- [x] 6.3 Record `factory.merge` in `factory-pull-requests.ts` `merge` for the enabler, with `pr-merged` and `remote-branch-deleted` effects, failing the activity (not the merge step) when the branch deletion fails; verify tests cover both outcomes
- [x] 6.4 Record `factory.disabled` where the watcher disables a factory whose enabler lost access, and `agents.stopped` in `stopProjectSessionsOnRunners` for the project owner with one `agent-stopped` effect per stopped session; verify tests cover each and that no activity is recorded when no session was running

## 7. Client

- [x] 7.1 Show the "Automatic" badge, the destructive marker and the effects list on Activity tab rows, with `data-testid` attributes, theme colours and en / es / pt strings for the badge and each effect; verify `activities.test.tsx` covers an implicit destructive row with effects and a user row without a badge, and add a Storybook story for it
- [x] 7.2 Add retry targets in `lib/activity-retry.ts` for `workspace.cleanup`, `workspace.prune`, `checkout.switch` and `sandbox.provision`, leaving server kinds without a target; verify `activity-retry.test.ts` covers each target, the fallback to the project and no retry for `sandbox.stop`
- [x] 7.3 Pass the dialog's `deleteBranch` through `handleDeleteThreadConfirm` → `deleteThread` → `api.deleteThread`, and correct the stale comment in `use-sidebar-actions.ts`; verify a test shows the delete request carries `deleteBranch: true` when the checkbox is set
- [x] 7.4 Run react-doctor on the changed client lines and fix what it reports; verify it reports no new diagnostics

## 8. Integration

- [x] 8.1 Run `bun run lint`, `bun run typecheck` and the affected test suites (shared, core, runtime, server, client); verify all pass
- [x] 8.2 Run `bunx fallow audit --base master`; verify the verdict is not `fail`
- [x] 8.3 Update `CLAUDE.md` (the `activities` tRPC paragraph, the scratch-thread removal sentence that names `thread-service/update.ts`, and the new workspace module and fitness check); verify every file it names exists
