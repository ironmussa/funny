# Tasks

## 1. Reusable runner thread launcher (pure refactor)

- [x] 1.1 Extract `startThreadOnRunner` (resolve runner → signed forward headers → `POST` on the runner → `registerThread` + `cacheThreadRunner`) from `routes/threads.ts` `createThreadOnRunner` into `server/src/services/runner-thread-launcher.ts`, returning a `Result` with `runner-unavailable` / `runner-error`; `createThreadOnRunner` becomes an adapter. Verify: the existing server thread-creation tests pass unchanged.
- [x] 1.2 Add launcher unit tests with fake `requests` / `presence` ports: picks the owner's runner, never another user's; returns `runner-unavailable` with no request sent when the owner has no eligible runner; the request carries a valid signed identity for the owner (`verifyForwardedIdentity` passes).

## 2. Server scheduler and dispatch

- [x] 2.1 Add `croner` to the server, move `AUTOMATION_DISALLOWED_TOOLS` to `@funny/shared`, and implement `server/src/services/automation-scheduler.ts` (`start`, `stop`, `reschedule`, `unschedule`, `runNow`) with `nextRunAt` maintenance. Verify with unit tests on an injected clock/launcher: an enabled automation fires, a disabled one does not, reschedule changes `nextRunAt`, unschedule stops firing, and there is no catch-up on `start`.
- [x] 2.2 Implement dispatch bookkeeping (D4): a successful dispatch creates a `running` run + `lastRunAt` + an `automation:run_started` event; a failed dispatch records a failed run with its reason against an archived placeholder thread. Verify with integration tests against the test DB, including "owner runner offline → failed run in history, no other runner contacted".
- [x] 2.3 Wire the scheduler into `server/src/index.ts` (start after the runner transport is ready, stop on shutdown) and mark runs stuck in `running` for over 24 h as failed on start. Verify with a test for the stale-run sweep, plus a server boot check (`bun --check packages/server/src/index.ts`).

## 3. Run completion

- [x] 3.1 Add `onThreadTerminal(threadId, status)` (D5) and call it from `notifyTerminalStatusPersisted` in `data-handler.ts`. Verify with tests: completed → completed/findings/summary/pending; failed/stopped/interrupted → failed and still visible; a second terminal update is a no-op; a non-automation thread is ignored.
- [x] 3.2 Archive threads beyond `maxRunHistory` on completion. Verify with a test using `maxRunHistory = 2` and three completed runs, where the oldest run's thread gets archived.

## 4. Routes and rollout

- [x] 4.1 Make the create / update (including enable toggle) / delete routes call `reschedule` / `unschedule`; serve `POST /api/automations/:id/trigger` on the server via `runNow` (owner only, otherwise 404; 502 when the runner is unavailable). Verify with route tests, including "another user triggers → 404, no dispatch".
- [x] 4.2 Add migration `080_disable_automations_for_relaunch`. Verify with a migration test: enabled automations become disabled once, and an automation re-enabled afterwards stays enabled across a second `autoMigrate`.

## 5. Remove the runtime implementation

- [x] 5.1 Delete runtime `automation-scheduler.ts`, `automation-manager.ts`, `routes/automations.ts` (and its mount), the runner-provider `automations` stubs + the interface entries they implement, and the runtime `croner` dependency. Verify: no remaining references (`grep`), the runtime typechecks, and the runtime tests pass.
- [x] 5.2 Document automation execution (server-owned cron, owner's runner, completion hook, single-instance assumption) in openwiki and check that the links resolve.

## 6. Integration

- [ ] 6.1 Run `bun scripts/fitness/check-typecheck.ts` and the server, runtime, and shared test suites. Manually create an automation with a 1-minute schedule against a connected runner, and confirm that a thread appears, the run completes in the inbox, and disabling it stops further runs.
