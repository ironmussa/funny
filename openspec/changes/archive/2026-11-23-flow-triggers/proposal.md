# Proposal

## Why

The server's flow executor can only be started by a GitHub issue: every factory run is keyed
to an issue number, and the flow's inputs are built from that issue. ADR 0002 separates the
**trigger** (when a flow starts and with what data) from the **flow**, and names "three
separate orchestrators" as the thing to remove. The standalone orchestrator and the thread
scheduler are gone (#429, #430); what remains is that work with no issue behind it (a nightly
audit, a dependency update) still needs a second mechanism, the automations, which can only
start one read-only thread.

## What Changes

- A factory run no longer needs an issue. A run records the **trigger** that started it and
  the inputs that trigger supplied; an issue is one kind of subject, not a requirement.
- A flow may be started when the trigger supplies every input the flow requires. A flow that
  asks for `issue_number` can only be started by an issue; a flow that asks for nothing
  beyond `repo` and `branch` can be started by any trigger.
- New trigger: **schedule**. A factory member with `steer` adds a cron schedule with a flow
  and input values; the factory starts that flow at each occurrence, as the enabler, under
  the factory's concurrency cap. An occurrence is skipped while the trigger's previous run is
  still in flight.
- New trigger: **run now without an issue**. From the factory view, a member starts a flow
  with input values typed in a form.
- The existing triggers are unchanged in behavior and are recorded under the same model: an
  issue sent to the queue (`manual`) and a labelled issue (`label`).
- An issueless run cannot use the steps that judge a change against an issue: `triage`,
  `review`, `regression_proof` and `merge`. A flow that has them is refused for an issueless
  trigger when the trigger is saved and again when the run starts. An issueless run can
  therefore open a pull request but never merges one by itself.
- The factory view shows an issueless run by its trigger's name instead of an issue number.

Out of scope: moving automations onto the executor (the next change, once schedule triggers
exist), starting a flow on an existing thread, the commit / webhook / child-agent triggers
of ADR 0002, and the runtime's workflow runs (`/api/workflows`).

## Capabilities

### New Capabilities

- `flow-triggers`: what may start a factory flow, the inputs a trigger supplies, schedule
  triggers and issueless runs, and what an issueless run may not do.

### Modified Capabilities

- `factory-pipeline-board`: a run card and the run panel show a run that has no issue.

## Impact

- **Database:** new `factory_runs` columns for the trigger kind, the trigger id and the
  supplied inputs (`issue_number` stores `0` for a run without an issue); the
  one-active-run index is restated for issue runs and a second one added per schedule
  trigger; new table `factory_triggers`. No column or table is dropped.
- **Server:** `services/factory/` (`factory-runs.ts`, `factory-watcher.ts`,
  `factory-flow-runs.ts`, `factory-flow-validation.ts`, `factory-queue.ts`), the `factory`
  tRPC group and `trpc/ports/factory.ts`.
- **Shared:** `contracts/factory.ts` (`issueNumber` becomes optional on a run; trigger
  schemas).
- **Client:** `data/factory/`, the factory settings (a Triggers section, indexed in
  `settings-index.ts`), `FactoryQueueView` and the run card / panel.
- **Docs:** `openwiki/architecture/issue-factory.md`, `GLOSSARY.md` (Trigger), and
  `docs/architecture/state-machines.md` if the run machine gains an entry state.
- No change to runner isolation: a triggered run still starts its threads through
  `startThreadOnRunner` as the enabler.
