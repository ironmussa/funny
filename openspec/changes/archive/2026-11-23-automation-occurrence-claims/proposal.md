# Proposal

## Why

Step 4 of unifying the orchestrators was "run automations on the factory's flow executor"
(ADR 0002: "over time funny's runtime pipelines and automations would run there too").
Reading both sides, that move would make the simple thing depend on the complex one, for no
new behavior:

- An automation is one read-only thread on a schedule, with an inbox. It needs no GitHub
  repository, no GitHub App and no factory. Its whole server side is about 560 lines
  (`automation-scheduler.ts`, `automation-runs.ts`).
- The flow executor is built around a factory: a run belongs to a `factory_settings` row,
  a tick does nothing until the project's GitHub repository resolves, and flows are read
  from the repository's default branch. Hosting automations there means either requiring
  GitHub for every automation or first extracting a host-independent executor from about
  13,000 lines of factory code.

What the two do share is small, and it is where automations are weaker today: **firing a
schedule**. The automation scheduler says so itself: "Single-instance assumption: every
server process that calls `startAutomationScheduler` fires every automation." Two server
processes start two runs for one occurrence; the only guard is the exclusive bind of the
HTTP port. The factory's schedule triggers (openspec `flow-triggers`) already take an
occurrence with a compare-and-set on `next_run_at`.

So this change unifies that one mechanism and records the decision not to merge the rest.

## What Changes

- A scheduled occurrence of an automation is **claimed** in the database before its run
  starts: `automations.next_run_at` moves to the next occurrence only while it still holds
  the due one. A server process that loses the claim starts nothing.
- The cron helpers (is this pattern valid, when is the next occurrence, claim this
  occurrence) live in one module used by automations and by the factory's schedule
  triggers, instead of one copy in each.
- Manual runs, the overlap skip, the stale-run sweep, the inbox and the read-only rules of
  automations do not change.
- ADR 0002 is amended: automations stay their own host, and why. The glossary says when to
  use an automation and when a factory schedule.

Not in this change: running automations as flows, giving automations more than one step,
and declaring the server safe to run as several instances (the factory watcher and the
runner transport have their own single-instance assumptions).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `automation-execution`: a scheduled occurrence starts at most one run, however many
  server processes are running.

## Impact

- **Server:** `services/automation-scheduler.ts` (the claim before `fire`), a new
  `services/schedules.ts` (cron validation, next occurrence, the claim), and
  `services/factory/factory-triggers.ts` once `flow-triggers` is merged (it adopts the
  shared helpers; its behavior does not change).
- **Database:** none. `automations.next_run_at` already exists and is already written
  after every occurrence.
- **Docs:** `docs/adr/0002-factory-triggers-flows-threads.md`, `GLOSSARY.md`,
  `openwiki/architecture/pipelines-and-automation.md`.
- No API, contract or client change.
