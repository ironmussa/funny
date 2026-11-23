# Design

## Context

See proposal.md for the motivation. What shapes the approach:

- A `factory_runs` row has `issue_number INTEGER NOT NULL`, and the partial unique index
  `factory_runs_one_active_per_issue (factory_id, issue_number)` allows one run in flight
  per issue. `FactoryRunJob` carries a `FactoryIssue`, and `factory-flow-runs.ts` builds the
  flow's inputs from it (`issue_number`, `issue_title`, `issue_url`) next to the ones the
  factory supplies (`repo`, `branch`, `base_branch`, `factory_id`).
- `factoryRunBranch` names the branch `factory/issue-<n>-<run id>`.
- The watcher (`factory-watcher.ts`) ticks each enabled factory every 60 s: it admits the
  queue (`admitQueue`), then labelled issues (`admitFromGithub`), and resumes runs whose
  flow is not running in this process (`resumeRuns`).
- `source` on a run is `manual` or `label`.
- Automations already validate cron patterns with croner (`parseAutomationSchedule`) and
  skip a tick while the previous run is `running`.
- The steps `triage`, `review`, `regression_proof` and `merge` read the issue: triage writes
  the contract from it, the review judges a commit against that contract, the proof and the
  merge depend on the review. None of them has a meaning without an issue.

## Goals / Non-Goals

**Goals:**

- One model for "what started this run": a trigger kind plus recorded inputs.
- Issue runs behave exactly as today; no change to their states, gates or queue order.
- Issueless runs reuse the executor unchanged: threads through `startThreadOnRunner`, the
  journal and resume, concurrency groups, stop / retry.

**Non-Goals:**

- A generic `flow_runs` table separate from `factory_runs`. The factory's run row stays the
  record; splitting it is only worth it if a second host needs runs.
- Triggers defined in the flow's YAML. The flow says what it needs; who starts it is a
  setting of the factory.
- A quality gate for issueless pull requests (a review without a contract). Until one
  exists, issueless runs do not merge.

## Decisions

### D1. The run row gains a trigger and inputs; the issue becomes optional

`factory_runs.source` already says how a run came in (`manual`, `label`); it is the trigger
kind, widened to `'manual' | 'label' | 'schedule' | 'run_now'` (the column is free text, so
no migration of values). The row also gets `trigger_id TEXT NULL`, `trigger_name TEXT NULL`
(the trigger's name when the run started, so a run still shows it after the trigger is
renamed or removed) and `inputs TEXT NULL` (JSON object of strings). `issue_number` stays
`NOT NULL` in the database and stores `0` for a run without an issue; the runs repository
is the only place that maps `0` to "no issue" (`issueNumber: number | null` on
`FactoryRunView`), the same boundary sentinel the schema uses for a scratch thread's
project.

_Alternative: a separate table for issueless runs._ Rejected: the board, run control, the
journal, step timings and thread links all join on `factory_runs.id`; a second table would
duplicate every reader.

_Alternative: the schedule creates a GitHub issue and the normal issue flow runs on it._
Rejected: it writes to the repository on every occurrence, needs issue-write permission the
App does not ask for today, and still cannot express a flow that should not open an issue
(an audit that only notifies).

_Alternative: make `issue_number` nullable._ Rejected: SQLite cannot drop `NOT NULL` in
place, `db/migrate.ts` has no table-rebuild helper, and rebuilding the factory's main table
is a larger risk than a sentinel read in one module. GitHub issue numbers start at 1, so `0`
cannot collide.

### D2. Two partial unique indexes instead of one

`factory_runs_one_active_per_issue` is restated with `AND issue_number > 0`. A second
partial index `factory_runs_one_active_per_trigger (factory_id, trigger_id)` over the
in-flight states and `trigger_id IS NOT NULL` enforces "one run in flight per schedule
trigger" in the database, so two server instances ticking the same factory cannot both
start an occurrence. `run_now` runs have no `trigger_id` and are not limited.

Parked states (`waiting_human`, `needs_info`) are left out of the trigger index: a nightly
run that opened a pull request must not block the next night.

### D3. The job's issue is nullable, and the issue-only steps refuse without one

`FactoryRunJob.issue` becomes `FactoryIssue | null`. The flow's inputs are built by one
function, `flowInputsOf(job, …)`: the issue inputs for an issue run or the run's recorded
`inputs` otherwise, then the factory inputs, which always win, so a trigger cannot replace
`repo` or `branch`. `factoryRunBranch` returns `factory/run-<run id>` when there is no issue,
and thread titles use `run-<id>` where an issue run has `#<n>`.

`FactoryRunScope.issueNumber` becomes `number | null`; triage and the reviewer take an
`IssueRunScope` (a number). The action provider still builds both roles for every run, on a
scope whose issue number is never used for a run without one: the four step entries
(`triage`, `review`, `regression_proof`, `merge`) refuse first, the early review of
`wait_ci` is skipped, and "no change" ends the run `done` instead of commenting on an issue.

_Alternative: a subject union on the job, with the issue-only steps unreachable by type._
Rejected after reading the provider: triage and the reviewer are captured by the CI and
merge closures (carrying verdicts across commits, the early review), so making them
optional touches every one of those paths for no behavior the validation in D4 does not
already guarantee.

### D4. What an issueless run may run is decided by flow validation

`factory-flow-validation.ts` already refuses what a factory cannot apply. It gains a second
entry, `validateFlowForIssuelessRun(flow, suppliedInputs)`, which reports:

- every node whose step is `triage`, `review`, `regression_proof` or `merge`;
- every required input not covered by the factory inputs plus the supplied names.

It runs in three places: saving a schedule trigger, `run_now`, and at the start of the run
(`runFlow`), where a problem fails the run with `formatFactoryFlowProblems`. The start-time
check is the one that counts: the flow is re-read from the default branch for each run and
may have changed since the trigger was saved.

_Alternative: let the review step run without a contract._ Rejected for this change: the
review's verdict format and the merge gate are specified against a contract.

### D5. Schedules are evaluated on the watcher's tick, not by their own timers

Each trigger stores `next_run_at`. On a factory's tick, before `admitQueue`, the watcher
selects the factory's enabled triggers with `next_run_at <= now`, and for each:

1. computes the next occurrence with croner and writes it with a compare-and-set
   (`UPDATE … SET next_run_at = :next WHERE id = :id AND next_run_at = :due`, row count
   checked) so only one instance takes the occurrence;
2. inserts the run in `requested` with the trigger's inputs; the trigger index (D2) refuses
   it when the previous run is in flight, and the watcher records a
   `factory.trigger_skipped` server activity.

The run is then admitted by the queue like a sent issue, which gives it the concurrency cap
and the queue order for free.

_Alternative: one croner job per trigger, as automations do._ Rejected: it needs a second
lifecycle (schedule / unschedule on every settings change) and a separate answer for
multi-instance. The tick is at most 60 s late, which is acceptable for a schedule.

A missed occurrence is not replayed: step 1 always moves `next_run_at` to the next future
occurrence, and an occurrence that is more than five minutes late when its tick comes (the
server was down, or the factory was paused) is taken and dropped without a run.

### D6. Trigger storage and API

Table `factory_triggers`: `id`, `factory_id` (cascade), `name`, `kind` (`schedule` only for
now), `schedule`, `flow_name`, `inputs` (JSON), `enabled`, `next_run_at`, `created_at`,
`updated_at`. tRPC, in the `factory` group and its port: `triggers` (`view`), `saveTrigger`,
`removeTrigger` and `runFlow` (`projectProcedure('steer')`), and `issuelessFlow` (`view`):
whether a flow can run without an issue and the inputs to type, for the two dialogs. The schemas live in
`contracts/factory.ts`; input names match `^[a-z][a-z0-9_]*$` and are passed through
`validateSecretName` so a credential-shaped name is refused.

`enabled` is a boolean, not a status: a trigger has no lifecycle beyond on / off.

### D7. `done` is a new terminal state

`FactoryRunState` gains `done`, terminal, reached only from an in-flight state by a run with
no issue whose flow completed without a pull request. It is added to `TERMINAL_STATES`, to
the board's Done column, and to the inventory in `docs/architecture/state-machines.md`. An
issue run still ends `no_change` in that case, so no existing transition changes.

An issueless run that opened a pull request ends where an `issue-to-pr` run does, and the
existing "pull request found on its branch" follow-up closes it.

### D8. Client

- Settings: a "Triggers" section in the factory settings (`SettingsSection` with a
  `settingId`, entries in `settings-index.ts`), a list with add / edit / remove, the cron
  field reusing the automation form's validation message.
- Factory view: a "Run a flow" action opening a dialog with a flow select (flows from
  `factory.flows`, minus the ones `validateFlowForIssuelessRun` refuses) and one input per
  declared input.
- `data/factory/`: triggers as a query (request-shaped, no per-row writes), invalidated by
  the save / remove actions.
- Run card and panel read `run.issueNumber ?? null` and fall back to the trigger's name.

## Risks / Trade-offs

- [`issueNumber` becomes optional on the run contract, and every reader must handle it] →
  The type change makes each reader a compile error until handled; `FactoryQueueView`, the
  run panel and the Issues tab are the known ones.
- [A reader that bypasses the repository sees issue `0`] → The column is read
  only in `factory-runs.ts` today (five places), so the mapping has one home; a test asserts
  that an issueless run maps to `issueNumber: null` in the run list, the board and the
  thread chip.
- [Restating the one-active index drops and recreates it] → The migration does both in one
  step, as migration 098's successor already does, and a migration test seeds an in-flight
  row per kind and checks both indexes afterwards.
- [A schedule that opens a pull request every night accumulates open pull requests] → The
  run card shows them under "Needs a person"; a later change can add "skip while the
  previous pull request is open" as a trigger option.
- [Trigger inputs are interpolated into agent prompts] → They are written by a member with
  `steer`, the same trust as a flow override or an automation prompt; the settings say they
  are visible to every member and must not hold secrets.
- [A tick-based schedule can be up to a minute late and is skipped while the factory
  cannot work] → Stated in the settings help text; the skip is recorded as an activity.

## Migration Plan

1. Ship the schema migration (new columns, restated index, new index, `factory_triggers`)
   with the server code; it only adds columns, a table and indexes.
2. Ship the server validation and the `run_now` / trigger procedures.
3. Ship the client.

Rollback: disable every trigger (`UPDATE factory_triggers SET enabled = 0`) and deploy the
previous server. Issueless rows already written have `issue_number = 0`; the previous code
would show them as issue #0 and could resume them as an issue run, so stop every issueless
run in flight before rolling back.

## Open Questions

- Should `run_now` runs count toward the factory's `maxConcurrent`? The design says yes
  (they go through the queue); a "run immediately, outside the cap" option can be added
  without changing the model.
- The label of the new terminal state in the UI ("Done" vs "Finished").
