# Tasks

## 1. Schema and migration

- [x] 1.1 Add `source`, `flow_name`, `queue_order`, `wait_reason`, `admitted_at` to `factory_runs` and `mode` to `factory_settings` in `packages/shared/src/db/schema.sqlite.ts` and `schema.pg.ts`; verify the dialect-mirror check in `bun run lint` passes
- [x] 1.2 Add migration `NNN_factory_manual_queue` to `packages/server/src/db/migrate.ts` (both dialects) that adds the columns and sets `mode = 'automatic'` on existing factory rows, and mirror it in the server and shared test DB helpers; verify with a migration test that an existing factory row ends in `automatic` mode and existing runs with `source = 'label'`
- [x] 1.3 Add `requested` to `FactoryRunState` and the new fields (`source`, `flowName`, `waitReason`, `queueOrder`) to `FactoryRun`, and `mode: 'manual' | 'automatic'` to `FactorySettings` / `saveFactorySettingsInput` in `packages/shared/src/contracts/factory.ts`; verify `bun run typecheck` passes

## 2. Run states and the run repository

- [x] 2.1 Declare the server factory run transition table in `factory-runs.ts` (including `requested → queued` and `requested → stopped`), keep `requested` out of `IN_FLIGHT_STATES` and out of the slot count; verify with table tests that `countActive` and `inFlight` ignore `requested` and that the unique index refuses a second `requested` row for one issue
- [x] 2.2 Add repository methods: insert a batch of `requested` runs with consecutive `queue_order` in one transaction (per-issue "already in the factory" on a unique violation), list `requested` by `queue_order`, CAS `admit` (`requested → queued`, sets `admitted_at`), CAS `cancel`, `clearQueue`, and `setWaitReason` (write only on change); verify with tests for each, including a lost CAS between admit and cancel
- [x] 2.3 Record `flow_name` and `source` on every run write, and make `failedCount` re-admission apply to `label` runs only; verify a test that a failed `manual` run is not re-admitted
- [x] 2.4 Add the server factory run machine to the inventory in `docs/architecture/state-machines.md`; verify the table there names `factory-runs.ts` as the transition table

## 3. Run's own flow

- [x] 3.1 Make `factory-flow-runs.ts` load the run's `flowName` (falling back to the factory's flow for rows without one) for start, resume, retry and take-over; verify tests where a run sent with `issue-to-pr` keeps that flow after the factory's flow changes and after a resume
- [x] 3.2 Add a flow catalog read to `factory-flow.ts`: built-in factory flows plus the default branch's `.funny/workflows/*.y{a,}ml`, minus workspace-only flows; verify with a fake contents API that `factory-issue` is excluded and repository flows are listed

## 4. Dependencies

- [x] 4.1 Move `openBlockers` from `packages/orchestrator/src/adapters/github-app-issue-source.ts` into `@funny/core/github-app` (the orchestrator's HTTP-level fake needed no move; the core function has its own test) and import it back in the orchestrator; verify the orchestrator's `factory-admission.test.ts` still passes unchanged
- [x] 4.2 Expose blockers in `factory-github.ts` with the enabler-capped App token, and write a pure `blockerVerdict(issue, blockers, runsByIssue, queue)` that returns finished / a wait reason kind (not sent, in progress, waiting merge, failed, circular, unreadable); verify table tests for every row of design decision 5, including "closed or merged here counts as finished" and a cross-repository blocker

## 5. Admission in the watcher

- [x] 5.1 Rework `admitIssues` in `factory-watcher.ts`: free slots, then `requested` runs by `queue_order`, then labelled issues only in automatic mode; skip blocked candidates (recording `wait_reason`) without stopping the walk; admit a manual run by CAS then `flows.start`; verify watcher tests for: cap respected with a queue, queue before label, oldest first within one send, blocked head does not hold up the next, paused factory admits nothing and keeps the queue, manual mode ignores labelled issues, sending works in automatic mode, pausing keeps the mode
- [x] 5.2 Apply the blocker check to label admissions too; verify a test that a labelled issue blocked by an open issue waits and is admitted once the blocker's run merges
- [x] 5.3 Update `openwiki/architecture/issue-factory.md` (queue, `requested`, manual / automatic modes, dependencies, pause semantics); verify the "A run" and "Operator controls" sections describe the new admission order

## 6. API

- [x] 6.1 Implement `submitIssues` in `packages/server/src/trpc/ports/factory.ts` per design decision 4 (factory exists and enabled, live `resolveTarget` and GitHub read, flow resolution, per-issue validation, one insert, tick wake) and the procedure in `packages/api/src/routers/factory.ts` with `projectProcedure('steer')` and its zod input in `contracts/factory.ts` (1–50 issues); verify port tests for paused, not configured, runner offline, unknown and workspace-only flow, closed issue, pull request, already queued, and a partial send
- [x] 6.2 Add `flows`, `blockers` (`view`), `clearQueue`, `stopAll` (a waiting issue is cancelled with the existing `stopRun`) (`steer`, caller's own factory) and `mode` on `save` (switching modes keeps the label); verify router tests that a view-only user gets 403 on the mutations and that `stopAll` clears the queue and stops in-flight runs while `clearQueue` leaves them running

## 7. Client

- [x] 7.1 Extend `data/factory/` (queries for flows and blockers, actions for submit, cancel, clear, stop all, invalidating the runs query); verify with data-layer tests using the factory's testing seed
- [x] 7.2 Issues tab: shadcn `Checkbox` per selectable issue, state badge (opens the run's last thread, cancel on waiting runs) for issues in the factory, the bottom send bar with the flow `Select`, disabled send with the reason when missing / paused / blocked, blocker warning, per-issue refusal display, and the required `data-testid`s; verify `IssuesTab` component tests for each state and the `Issues/IssueFactoryControls` Storybook stories
- [x] 7.3 Factory settings and runs: the mode selector (label field only in automatic mode) and "running / paused" wording in `ProjectFactorySetting.tsx`; waiting runs with their reason plus "Clear queue" and "Stop all" (`AlertDialog`) in `ProjectFactoryRuns.tsx`; verify component tests and that strings go through i18n

## 8. Integration

- [x] 8.1 Run `bun run lint`, `bun run typecheck` and the factory, orchestrator and client test suites; verify all pass, including `fitness:trpc-api`
- [x] 8.2 Run `openspec validate factory-manual-queue --strict`; verify it reports no errors
