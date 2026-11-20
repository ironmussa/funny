# Proposal

## Why

Today a project's issue factory has one switch: turning it on admits every open issue that
carries the watched label, up to the concurrency cap. A user who wants to work at their own
pace (send two issues, look at the results, send three more) has to curate labels in
GitHub and wait for the next poll, and cannot say which flow a given issue should run. Two
related issues sent together also start at the same time, even when one depends on the
other.

## What Changes

- **Send issues to the factory from funny.** The Issues tab gets a checkbox per issue and,
  while some are selected, a bar with a flow selector and a "Send to factory" button. Sent
  issues go into the caller's own factory queue. Issues already queued or running show
  their factory state instead of a checkbox.
- **A factory queue.** A sent issue waits in a new `requested` state that holds no
  concurrency slot. The factory admits queued issues in the order they were sent (oldest
  issue first within one send) as slots free up, before any labelled issue.
- **The flow is chosen per issue.** Each run records the flow it was sent with; resume,
  retry and take-over use the run's flow, not the factory's current setting. The
  factory's flow becomes the default of the selector and the flow of label admissions.
- **Factory modes: manual and automatic.** A factory runs in one of two modes. In
  **manual** mode it admits only what is sent to it. In **automatic** mode it also admits
  issues carrying its label, after the sent ones. Sending issues works in both modes. New
  factories start in manual mode; existing factories move to automatic mode, so nothing
  changes for them until their owner switches. The mode (what comes in) is separate from
  running / paused (whether it works now). funny never writes labels to GitHub.
- **Pause, clear and stop all.** Turning the factory off pauses it: nothing leaves the
  queue, the queue is kept, running work finishes, and sending is refused. "Clear queue"
  removes the issues still waiting. "Stop all" clears the queue and stops every running run
  (after a confirmation). A waiting issue can be cancelled on its own.
- **Sending is refused when the factory cannot work.** When the factory is paused, or the
  enabler's runner is unreachable, sandbox threads cannot be launched, the GitHub App is
  missing or the repository cannot be read, the send fails with the reason and nothing is
  queued.
- **Issue dependencies.** An issue blocked by another (GitHub's native "blocked by"
  relation) is not admitted until every blocker is closed or has a factory run that merged.
  A blocked issue does not hold up the rest of the queue, and it shows why it waits
  (blocker not sent, blocker waiting for a merge, blocker failed or stopped, circular
  dependency). This also applies to label admissions. **BREAKING** for factories in
  automatic mode: a blocked labelled issue now waits instead of starting.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `issue-factory`: runs record their own flow (the "Admitted issues run the configured
  flow" requirement changes), and new requirements cover sending issues, the queue and its
  order, pause / clear / stop all, refusing a send the factory cannot act on, the optional
  manual and automatic modes, and issue dependencies.

## Impact

- **DB** (`packages/shared/src/db/schema.{sqlite,pg}.ts`, `packages/server/src/db/migrate.ts`):
  `factory_runs` gains `source`, `flow_name`, `queue_order`, `wait_reason`,
  `admitted_at`; `factory_settings` gains `mode` (`manual` by default, `automatic` for existing rows).
  The new `requested` run state is covered by the existing one-active-run-per-issue index.
- **Server** (`packages/server/src/services/factory/`): admission in `factory-watcher.ts`
  (queue first, dependencies, run's flow), `factory-runs.ts` (new state and transitions,
  compare-and-set), `factory-flow-runs.ts` / `factory-run-control.ts` (run's flow, cancel,
  clear, stop all), `factory-flow.ts` (list the repository's flows), `factory-github.ts`
  (blockers).
- **Shared GitHub logic**: `openBlockers` moves from
  `packages/orchestrator/src/adapters/github-app-issue-source.ts` into
  `@funny/core/github-app` so both factories use it.
- **API** (`packages/api/src/routers/factory.ts`, `packages/shared/src/contracts/factory.ts`,
  `packages/server/src/trpc/ports/factory.ts`): `submitIssues`, `flows`, `blockers`,
  `clearQueue`, `stopAll` (a waiting issue is cancelled with the existing `stopRun`);
  `save` accepts `mode`.
- **Client**: `IssuesTab.tsx` (selection, send bar, per-issue factory state),
  `data/factory/`, `ProjectFactorySetting.tsx` (mode selector, label shown only in automatic mode, running / paused wording),
  `ProjectFactoryRuns.tsx` (queued runs, clear, stop all).
- **Docs**: `openwiki/architecture/issue-factory.md`, `docs/architecture/state-machines.md`.
