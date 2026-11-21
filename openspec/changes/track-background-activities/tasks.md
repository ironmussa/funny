# Tasks

## 1. Shared model

- [x] 1.1 Add the `Activity` type, `ActivityStatus` and the `activity:updated` / `activity:removed` / `activity:progress` event types to `packages/shared`; verify `bun run typecheck` passes
- [x] 1.2 Add `shared/src/activity-machine.ts` (transition table and pure `nextActivityStatus`, design D2); verify a unit test covers every legal transition and refuses `succeeded → failed`, `failed → succeeded` and `interrupted → running`
- [x] 1.3 Add the kind registry `shared/src/activities/kinds.ts` with the input schemas of `project.clone`, `worktree.setup`, `git.workflow` and `stripUrlCredentials`; verify unit tests show an undeclared field is dropped, an unknown kind is refused and `https://user:token@host/repo.git` loses its credentials
- [x] 1.4 Add the `activities` table to `db/schema.sqlite.ts`, `db/schema.pg.ts` and `db/migrate.ts` with the two indexes of D2; verify the migration test creates the table on a fresh SQLite database
- [x] 1.5 Add `shared/src/repositories/activity-repository.ts` (insert, compare-and-set update, list by user, delete, clear finished, reconcile by runner, cap at 500); verify repository tests cover a refused transition returning "not applied", reconcile leaving listed ids untouched, and the cap deleting only the oldest `succeeded` rows
- [x] 1.6 Add the Activity machine to the "Explicit machines" table in `docs/architecture/state-machines.md`; verify the entry names the machine file and the repository that enforces it

## 2. Runner protocol and server data channel

- [x] 2.1 Add `ActivityStart`, `ActivityUpdate` and `ActivityReconcile` to `protocol/runner/v2/operations.proto`, run `bun run protocol:generate` and update the fixtures; verify `bun run protocol:lint`, `bun run protocol:breaking` and `bun run protocol:fixtures:test` pass
- [x] 2.2 Map the three operations in `server/services/grpc/operations-handler.ts` and add their handlers to `data-message-handlers.ts`, overwriting `userId` and `runnerId` from the session and validating `input` with the kind schema; verify handler tests show a payload naming another user is recorded for the runner's owner
- [x] 2.3 Add the scope rules (`DATA_SCOPE_RULES`) and ownership checks (`data-ownership.ts`) of design D5; verify tests refuse a start for a project the runner cannot serve, a projectless start from a dedicated runner, and an update of a row owned by another runner
- [x] 2.4 Mark a runner's `running` activities `interrupted` when the runner is deleted through `runner-manager`; verify a test deletes a runner and reads its activity as `interrupted`
- [x] 2.5 Broadcast `activity:updated` to the owner after each accepted write and nothing after a refused one; verify a test with a fake `relayToUser` sees one event per accepted write

## 3. Server API

- [x] 3.1 Add the contract schemas (`shared/src/contracts/activities.ts`) and the `activities` router to `@funny/api` (`list`, `dismiss`, `clearFinished`); verify `bun run lint` passes `fitness:trpc-api`
- [x] 3.2 Implement `server/src/trpc/ports/activities.ts` (design D6), including the 409 for a `running` row whose runner is connected and the `activity:removed` broadcast; verify port tests cover: list returns only the caller's rows, dismiss of another user's row answers 404, dismiss of a running row with a connected runner answers 409 and with an offline runner deletes it, clear keeps running rows
- [x] 3.3 Add `activities` to `MIGRATED_GROUPS` in `scripts/fitness/check-trpc-api.ts` and to the tRPC group list in `CLAUDE.md`; verify `bun run lint` passes

## 4. Runner tracking

- [x] 4.1 Add the three operations to `runtime/src/services/grpc-operations-adapter.ts` and the runtime service provider; verify the adapter test round-trips each one
- [x] 4.2 Implement `runtime/src/services/activity-tracker.ts` (`trackActivity`, `step`, `progress`, `result`, live-id set, terminal report retried with backoff, design D8); verify tests cover: `ok` reports `succeeded`, `err` and a thrown exception report `failed` with the message, a refused or failed report does not fail the operation, and the terminal report is retried after a disconnect and stops when interrupted
- [x] 4.3 Send `activity_reconcile` with the live ids on every runner (re)connect; verify a test shows an in-flight activity is listed and an empty list is sent after a restart
- [x] 4.4 Wrap the background clone in `runtime/src/routes/github/repos.ts`, reusing the `cloneId` and recording the created project as `resultRef`; verify the clone route tests show an activity started on 202, `succeeded` with the project id, and `failed` with the error when the directory exists, with no token in the recorded input
- [x] 4.5 Wrap the worktree setup in `runtime/src/services/thread-service/`, reporting each setup step as the activity's step; verify a test shows the step changes and a failed startup command ends the activity `failed`
- [x] 4.6 Wrap `git-workflow-service.ts` (kind `git.workflow`, PR URL as `resultRef`); verify a test shows a rejected push ends `failed` with git's message and a created PR ends `succeeded` with its URL
- [x] 4.7 Document the tracker and how to add a kind in `openwiki/` (architecture section); verify the page lists the three steps: declare the kind, wrap the call, add the retry target

## 5. Client data layer

- [x] 5.1 Add `client/src/data/activities/` (`store.ts`, `loaders.ts`, `read.ts`, `hooks.ts`, `testing.ts`) and register the collection in the data layer; verify `bun run lint` passes `check-client-data-layer` and a test seeds and reads rows through the hooks
- [x] 5.2 Add `apply-event.ts` for `activity:updated`, `activity:removed` and `activity:progress` and wire them in the realtime dispatch; verify tests show an update replaces the row, a removal deletes it, and a progress event for an unknown id is ignored
- [x] 5.3 Add `actions.ts` (optimistic dismiss and clear finished, rolling back with a toast) and the `lib/api` tRPC calls; verify tests show a rejected dismiss restores the row
- [x] 5.4 Reload the list in `data/resync.ts` on reconnect; verify a test shows a row that changed while disconnected is updated after resync
- [x] 5.5 Add `activities/` to the entity folder list in `CLAUDE.md`'s data-layer section; verify the list names it

## 6. Activity panel

- [x] 6.1 Install shadcn `Tabs` if it is not present (`bunx shadcn@latest add tabs`) and turn `WatcherPanelButton` into `ActivityPanelButton` with the Activity, Jobs and Watchers tabs, moving the existing lists unchanged; verify the existing jobs and watchers tests pass against the new component
- [x] 6.2 Build the Activity tab: running first, then finished newest first, each row with title, status icon, step or error, relative time, "runner offline" for a running row whose runner is not connected, and `data-testid`s (`activity-panel-*`, `activity-item-{id}`); verify component tests cover the ordering, the error text and the offline label, and that text sizes use the theme and font-size settings
- [x] 6.3 Show the running and failed counters on the footer button; verify a test with two running and one failed activity shows 2 and 1, and that dismissing the failed one drops it to 0
- [x] 6.4 Add dismiss per row and "Clear finished"; verify tests show dismiss is hidden on a running row with a connected runner and clear leaves running rows
- [x] 6.5 Add `lib/activity-retry.ts` and the retry action: clone opens `CloneRepoView` prefilled from the input, `worktree.setup` and `git.workflow` open the thread (review pane for the latter) and fall back to the project when the thread is gone; verify tests cover the three targets and the fallback, and that no request to start the operation is sent
- [x] 6.6 Let `CloneRepoView` take initial values (repository, destination, name); verify its test renders the form filled from a failed activity's input
- [x] 6.7 Raise a toast when a row changes to `failed`, with an action that opens the panel, and none on the initial list load; verify a test covers both cases
- [x] 6.8 Add the en / es / pt translations and a Storybook story for the panel (running, failed, interrupted, offline, empty); verify the story renders each state

## 7. Integration checks

- [x] 7.1 Run `bun run lint`, `bun run typecheck` and the affected test suites; verify all pass
- [ ] 7.2 End to end against a real runner: start a clone into an existing directory, navigate away, and verify the panel lists it as failed after a reload and retry opens the prefilled form
- [ ] 7.3 Restart the runner during a clone and verify the activity becomes `interrupted` once the runner reconnects
- [x] 7.4 Run `bunx fallow audit --base origin/master` and verify the verdict is not `fail`
