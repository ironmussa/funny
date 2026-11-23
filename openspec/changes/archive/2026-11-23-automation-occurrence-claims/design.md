# Design

## Context

See proposal.md for why automations are not moved onto the flow executor. What shapes this
change:

- `automation-scheduler.ts` holds one croner job per enabled automation. On each
  occurrence `fire(id)` re-reads the automation, skips when a run is still `running`
  (`runInProgress`), else starts a thread through `startThreadOnRunner`, then writes
  `next_run_at` (`recordNextRun`). Nothing stops a second process from doing the same.
- `next_run_at` is written when an automation is scheduled and after every occurrence, so
  between occurrences it holds the time of the next one.
- `parseAutomationSchedule` validates a pattern with croner; `flow-triggers` adds
  `scheduleProblem` and `nextOccurrence` in `factory-triggers.ts`, which do the same.
- Production runs one server replica (`.railway/railway.ts`), and `hosts/bun/listen.ts`
  binds the port exclusively so a second local process fails to start.

## Goals / Non-Goals

**Goals:**

- One run per occurrence without relying on there being one process.
- One implementation of "valid pattern", "next occurrence" and "take this occurrence".

**Non-Goals:**

- Replacing croner timers with a polling tick for automations: a tick would make every
  automation up to a minute late for no gain.
- Removing the exclusive port bind or claiming multi-instance support.
- A database guard for "one run in progress per automation": once an occurrence is taken by
  one process, the overlap check is no longer raced by a second one.

## Decisions

### D1. Claim the occurrence with a compare-and-set on `next_run_at`

In `fire(id)`, after the re-read and before the overlap check (`takeOccurrence`):

1. `stored` is the automation's `next_run_at` as just read, and `next` is the job's next
   occurrence (croner already answers the following one inside the callback);
2. if `stored` is `next` or later, a peer already took this occurrence: return;
3. `UPDATE automations SET next_run_at = :next WHERE id = :id AND next_run_at = :stored`
   (`IS NULL` when `stored` is null, so a row that never had one is claimed once); a row
   count of 0 means the claim was lost: return.

Only then the overlap check and `runAutomation` run. The `recordNextRun` after the run goes
away: the claim already wrote the value. `schedule()` still records the next occurrence when
an automation is scheduled.

_Alternative: an advisory lock per automation._ Rejected: SQLite has none, and the
codebase's rule for a stored state is a compare-and-set (`docs/architecture/state-machines.md`).

_Alternative: a unique `(automation_id, occurrence)` row in a new table._ It works, and it
would keep a history of occurrences, but it adds a table to hold what one existing column
already says.

### D2. The claim compares stored times, never a clock

Step 2 compares two occurrence times of the same schedule, not the process's clock, so the
processes' clocks may differ. Two timers firing for one occurrence both compute the same
`next`; the first write moves `next_run_at` to it, and the second process either reads that
value (step 2) or loses the write (step 3). "Or later" covers a process that reaches an
occurrence after a peer has already taken a newer one: it must not move the time backwards.

### D3. One schedules module, one claim per table

`services/schedules.ts` holds what is pure: `scheduleProblem(pattern)` (what
`parseAutomationSchedule` was, kept as an alias), `nextOccurrence(pattern, from)` and
`occurrenceTaken(stored, next)`, the rule of D1 step 2.

The conditional write stays in each table's repository (`claimOccurrence` in
`automation-repository.ts`): it is one statement, and a helper generic over two drizzle
tables would be longer than the two statements. `factory-triggers.ts` adopts the pure
helpers when `flow-triggers` is on the branch; its own `take` is already that write.

### D4. A lost claim is silent

A process that loses the claim logs at `debug` and records no `automation.skipped`
activity: the occurrence was not skipped, another process is running it. Only the overlap
rule records a skip, as today, and only in the process that won.

### D5. ADR 0002 is amended, not replaced

The sentence "over time funny's runtime pipelines and automations would run there too" is
replaced by what was decided: the flow executor stays the factory's; an automation is a
scheduled read-only thread with its own small host; they share how a schedule is fired.
The runtime's workflow runs (`PipelineDispatcher`) are left as they are and named as the
remaining second executor.

## Risks / Trade-offs

- [A process that crashes between the claim and the thread launch loses that occurrence]
  → The same happens today if it crashes inside `fire`; occurrences are never replayed by
  design. The run is not recorded at all in that case, which is why the claim is taken
  as late as possible: after the re-read, right before the overlap check.
- [An automation edited between occurrences has its `next_run_at` rewritten by
  `rescheduleAutomation`] → That write is not conditional and may land between a peer's
  read and claim, making the peer lose a claim it should have won. The new schedule's next
  occurrence then fires normally; at worst one occurrence of the old schedule is dropped
  at the moment of an edit.
- [A null `next_run_at` on Postgres] → the write uses drizzle's `isNull` or `eq`, chosen by
  whether the stored value is null, so no dialect SQL is needed.

## Migration Plan

Deploy the server. No data change: the first occurrence after the deploy is claimed
against the `next_run_at` the previous version wrote. Rollback is deploying the previous
server.
