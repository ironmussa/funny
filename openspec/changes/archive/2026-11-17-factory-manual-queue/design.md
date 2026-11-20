# Design

## Context

See proposal.md for the motivation and specs/issue-factory/spec.md for the behaviour.

The server factory (`packages/server/src/services/factory/`) admits work in one place.
Each tick of `factory-watcher.ts` (`fire`) re-checks the enabler's `steer`, resolves the
launch target (`resolveTarget`: runtime mode and repository), resumes in-flight runs not
driven in this process (`resumeRuns`), and, when enabled, lists labelled issues and
admits them up to the cap (`admitFromGithub` → `admitIssues` → `isAdmissible` →
`startImplement`). `startImplement` takes any issue: the label only matters in
`admitFromGithub`.

Constraints that shape the design:

- `queued` is in `IN_FLIGHT_STATES` (`factory-runs.ts`), and `resumeRuns` starts every
  in-flight run that is not active in this process. A row inserted as `queued` would
  therefore start on the next tick without regard to the cap. A waiting issue needs a
  state outside the in-flight set.
- The partial unique index `factory_runs_one_active_per_issue` (migration 098) is
  `(factory_id, issue_number) WHERE state NOT IN ('merged','failed','stopped')`. Any new
  non-terminal state is covered by it without a change.
- The run's flow is read from the factory row (`job.factory.flowName` in
  `factory-flow-runs.ts`), so a run cannot have its own flow today.
- `blockedReason` is written by the tick and can be up to a poll interval stale.
- The orchestrator already reads GitHub's native dependencies (`openBlockers` in
  `packages/orchestrator/src/adapters/github-app-issue-source.ts`, with a fake in its test
  helpers). The GitHub logic the two factories share lives in `@funny/core/github-app`.
- State-machine rule (`docs/architecture/state-machines.md`): transitions in one table,
  computed from the stored state, written with a compare-and-set whose row count is
  checked.

## Goals / Non-Goals

**Goals:**

- One admission path for sent and labelled issues: they differ only in where the
  candidates come from.
- No new process or timer: the queue is drained by the existing per-factory tick.
- The send validates against live state, so a refused send never leaves a row behind.

**Non-Goals:**

- Publishing the factory's state back to GitHub (labels or comments).
- Reading `Blocked by #N` from an issue body; only GitHub's native relation counts.
- Reordering the queue by hand, or priorities.
- Webhooks; admission stays on the poll.
- Cross-factory de-duplication of the same issue (two users' factories can still take
  the same issue; unchanged by this change).

## Decisions

### 1. A `requested` run state, outside the in-flight set

A sent issue becomes a `factory_runs` row in `requested`. `requested` is non-terminal (so
the one-active-run-per-issue index already refuses a second send of the same issue) but is
neither in `IN_FLIGHT_STATES` (so `resumeRuns` never starts it) nor slot-holding (so
`countActive` ignores it). Admission moves it to `queued` and starts the flow, exactly
where `startImplement` writes `queued` today.

Transitions added to the run state table (declared once in `factory-runs.ts`; today the
legal moves are implicit across `factory-runs.ts` and `factory-run-control.ts`, so this
change writes that table for the server factory run and lists it in
`docs/architecture/state-machines.md`):

```
  requested ──admit──▶ queued ──▶ (existing flow states)
  requested ──cancel / clear / stop all──▶ stopped
```

Each write is a compare-and-set (`UPDATE … WHERE id = ? AND state = 'requested'`, row
count checked): admission and a concurrent cancel cannot both win. A lost admission CAS
skips the row; a lost cancel answers that the issue already started.

_Alternatives:_ a separate `factory_requests` table (a second copy of "this issue is
taken" next to the run row, and the unique index would have to span both tables);
reusing `queued` with an extra flag (every reader of `IN_FLIGHT_STATES` would need to
learn the flag, and missing one bypasses the cap).

### 2. New `factory_runs` columns

- `source TEXT NOT NULL DEFAULT 'label'`: `'manual' | 'label'`. `isAdmissible`'s
  failure-count re-admission applies only to `label` runs; a manual run is never
  re-admitted by the factory (spec: processed once).
- `flow_name TEXT`: set when the row is written (the chosen flow for a send, the factory's
  flow for a label admission). Read by `factory-flow-runs.ts` instead of the factory's.
  Null only on rows written before this change, which fall back to the factory's flow.
- `queue_order INTEGER`: the queue position, `max(queue_order) + 1` per factory. One send
  assigns consecutive values in issue creation order (oldest first, using the
  `created_at` GitHub returns during validation). Each issue is its own insert, so the
  unique index can refuse one issue ("already in the factory") without failing the
  others; there is no transaction around the batch.
- `wait_reason TEXT`: why a `requested` run is not admitted yet (encoded kind plus the
  blocker numbers), written by the tick only when it changes, like `blockedReason`.
- `admitted_at TEXT`: set on `requested → queued`. `started_at` keeps meaning "row
  written" (send time for manual runs).

`factory_settings` gains `mode TEXT NOT NULL DEFAULT 'manual'` (`'manual' | 'automatic'`,
validated by the contract's zod enum). The migration sets `'automatic'` on every existing
row, so an existing factory keeps its label behaviour (spec: an existing factory moves to
automatic mode). The mode says what the factory admits; `enabled` keeps saying whether it
works now (running / paused), so pausing never changes the mode. The `label` column stays
NOT NULL with its default and is ignored in manual mode, which avoids a nullable-column
rebuild on SQLite and keeps the label across a switch to manual and back.

_Alternatives:_ a boolean `auto_admit` (rejected: a mode names what the factory does, and
a text column takes later modes such as approval, scheduled or daily-limited without a
second flag); one selector "manual / automatic / off" (rejected: pausing an automatic
factory would forget that it was automatic); making `label` nullable with null meaning
manual (rejected: SQLite NOT NULL removal needs a table rebuild, and the label would be
lost on a switch).

### 3. Admission order inside one tick

`fire` keeps its order (steer, target, resume) and then, when enabled:

1. Free slots = `maxConcurrent − countActive`.
2. Candidates = `requested` runs by `queue_order`, then, in automatic mode, labelled
   issues by creation date that have no run yet.
3. For each candidate while slots remain: read its blockers (decision 5). If blocked,
   record the wait reason and continue with the next candidate (no head-of-line
   blocking). If not, admit it: a manual run by CAS `requested → queued` then
   `flows.start`; a labelled issue through today's `startImplement`.

Sent issues always go before labelled ones, so switching to automatic mode never starves the
queue. A paused factory runs steps 1–3 not at all; `hasWork` is unchanged (a paused
factory with only `requested` rows is unscheduled and its queue just sits).

### 4. Sending validates live, then writes once

`factory.submitIssues({ projectId, issueNumbers (1..50), flowName })` is a
`projectProcedure('steer')`, acting on the caller's own factory only. The port:

1. Loads the caller's factory: none → `412 factory-not-configured`; disabled →
   `409 factory-paused`.
2. Runs the tick's own `resolveTarget` and a GitHub read with the App token capped by
   the enabler (the same checks that set `blockedReason`), now, not from the stored
   reason. Any failure → `409 factory-cannot-work` with the reason; nothing is written.
3. Resolves the flow with the factory's flow loader (built-in or the default branch's
   `.funny/workflows/`), refusing workspace-only flows; failure → `400` naming the flow.
4. Reads each issue (`getIssue`): missing, closed or a pull request → refused with its
   reason.
5. Inserts the accepted issues as `requested` in one transaction with consecutive
   `queue_order`. A unique-index violation for an issue is reported as "already in the
   factory" for that issue, not as a failure of the send.
6. Answers `{ accepted: number[], refused: { issue, reason }[] }` and wakes the factory's
   tick (`refreshFactory`) so admission does not wait up to a poll interval.

`factory.flows({ projectId })` lists the selectable flows: the built-in factory flows
plus the `.funny/workflows/*.y{a,}ml` files of the default branch (contents API, App
token), minus workspace-only flows. `clearQueue` and `stopAll` are
`projectProcedure('steer')` on the caller's own factory, like `stopRun`; `stopAll`
composes `clearQueue` with the existing stop of each in-flight run. A single waiting
issue is cancelled with the existing `stopRun` (it already ends any non-terminal run,
and a waiting one has no threads), so there is no separate `cancelRun`. `save` accepts
`mode`; sending is allowed in both modes.

A sent issue whose flow could not start any agent (the runner went offline between the
send and the admission) is not dropped as a label run is: it goes back to `requested`
in its place (`queued → requested`, the `requeue` transition), so the request is not
lost.

### 5. Dependencies: GitHub's relation, finished = closed or merged here

`openBlockers` moves into `@funny/core/github-app` as a function over the repository
client (`GET /repos/{repo}/issues/{n}/dependencies/blocked_by`, all pages), and the
orchestrator imports it from there. The orchestrator's GitHub fake answers at the HTTP
level, so it needs no move; the core function has its own unit test.
The server's `factory-github.ts` exposes it with the enabler-capped App token.

A blocker is finished when its issue is closed, or when the same factory has a run for
it in `merged` (covers an agent that forgot `Closes #N`). The factory computes the
reason a candidate waits from the blockers' states and their runs in the factory:

| Blocker                                           | `wait_reason` kind                                     |
| ------------------------------------------------- | ------------------------------------------------------ |
| open, no run in the factory                       | `blocker-not-sent`                                     |
| run in `requested` … `waiting_ci` / `fixing`      | `blocker-in-progress`                                  |
| run in `waiting_human` (PR waiting)               | `blocker-waiting-merge`                                |
| latest run `failed` / `stopped`, issue open       | `blocker-failed`                                       |
| blocked, transitively, by itself within the queue | `circular`                                             |
| open blocker in another repository                | `blocker-other-repo`                                   |
| blockers unreadable                               | `blockers-unreadable` (recorded; read again next tick) |

A cross-repository blocker counts only by its issue state (it cannot have a run here).
Cycle detection walks only the `requested` runs of the factory and their blockers, which
the tick has just read, so it costs no extra calls.

_Alternative:_ finished = issue closed only (the orchestrator's rule). Rejected: the
close depends on the agent writing `Closes #N`, and a missing one would block the
dependents forever.

### 6. Client: the Issues tab drives the factory

`IssuesTab.tsx` reads the caller's factory and its runs through `data/factory/` (the
`runs` query, keyed by issue number on the client). Rows with a non-terminal run show a
state badge instead of a checkbox (the badge opens the run's last thread); closed issues
and PRs have no checkbox. With a selection, a bar at the bottom of the tab holds the flow
`Select` (default: the factory's flow, options from `factory.flows`) and the send button.
The bar disables the button, with the reason, when the factory is missing, paused or has
a `blockedReason`, and warns about open blockers outside the selection (read through `factory.blockers({ projectId, issueNumbers })`, a
`projectProcedure('view')` that returns each issue's open blockers and whether each has a
run in the caller's factory).
A send answers per issue; refused issues stay selected with their reason.

Components: shadcn `Checkbox`, `Select`, `Button`, `Tooltip`, `AlertDialog` (Stop all),
`Badge`. Test ids: `issue-select-{n}`, `issue-factory-status-{n}`,
`issue-factory-cancel-{n}`, `issues-factory-flow`, `issues-factory-send`,
`issues-factory-warning`. `ProjectFactorySetting.tsx` gains the mode selector (the label field shows only in automatic mode) and
calls the on/off switch "running / paused"; `ProjectFactoryRuns.tsx` lists waiting runs
with their reason and holds "Clear queue" and "Stop all".

## Risks / Trade-offs

- [GitHub's dependencies API is newer than the issues API and may be missing on some
  hosts or plans] → An unreadable blocker list blocks the issue for that pass and the
  reason is shown; it does not fail the run. A persistent failure is visible as
  `blockers-unreadable` on every waiting issue.
- [One extra GitHub call per candidate per tick] → Only candidates that could take a free
  slot are checked, so the calls per tick are bounded by the queue walked until the slots
  are filled; blocked candidates are re-checked every tick until admitted.
- [Behaviour change for existing label factories: blocked labelled issues now wait]
  → Called out as **BREAKING** in the proposal; the wait reason says why.
- [The live check in `submitIssues` needs the runner and GitHub, so a send is slower
  than a DB write] → It is one target resolution and one read per issue (≤ 50); the UI
  shows a pending state on the button.
- [A paused factory with only waiting issues is unscheduled, so their wait reasons are
  not refreshed] → Reasons are recomputed on the first tick after resuming; while paused,
  the UI shows "paused" rather than per-issue reasons.
- [`queue_order` assigned with `max + 1` could race between two sends of one user]
  → Two concurrent sends may share a position; the queue orders ties by send time and
  id, so both still go in, in a stable order. Only the same user's factory can race.

## Migration Plan

1. Migration `NNN_factory_manual_queue` (both dialects, raw SQL in
   `packages/server/src/db/migrate.ts` and the test DB helpers): add the `factory_runs`
   columns, add `factory_settings.mode` and set it to `automatic` on every existing row.
   Existing runs keep `source = 'label'`, `flow_name` null (fallback to the factory's
   flow).
2. Deploy the server; the client can follow, since the new procedures are additive and
   `save` treats a missing `mode` as "keep".
3. Rollback: the old server ignores the new columns. Any `requested` rows would be
   neither resumed nor admitted by the old code (they are not in its in-flight set) but
   still hold the issue in the unique index; clear them with
   `UPDATE factory_runs SET state = 'stopped' WHERE state = 'requested'` before rolling
   back.
