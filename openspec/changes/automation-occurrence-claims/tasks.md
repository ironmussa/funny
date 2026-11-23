# Tasks

## 1. Schedules module

- [x] 1.1 Add `services/schedules.ts` with `scheduleProblem`, `nextOccurrence` and `occurrenceTaken`, `claimOccurrence` in `automation-repository.ts`, and keep `parseAutomationSchedule` as an alias of `scheduleProblem`. Verify with unit tests: a valid and an invalid pattern, the next occurrence after a given time, a claim that wins, one that loses, and one from a null `next_run_at`
- [ ] 1.2 (after `flow-triggers` merges) When `factory-triggers.ts` is on the branch, replace its `scheduleProblem` / `nextOccurrence` / `take` with the shared ones. Verify the existing schedule trigger tests pass unchanged

## 2. Claim before a scheduled run

- [x] 2.1 In `fire(id)`, return when the stored `next_run_at` is already the following occurrence, then claim the occurrence and return when the claim is lost; remove `recordNextRun` after the run. Verify with scheduler tests: two `fire` calls for one occurrence start one run, a late `fire` starts none and records no skip, a row without `next_run_at` is claimed once
- [x] 2.2 Keep manual runs outside the claim. Verify with a test that a manual run starts while `next_run_at` is in the future and leaves it unchanged
- [x] 2.3 Verify the existing behavior tests still pass: disabled automation, schedule change, overlap skip recorded once, stale-run sweep, invalid stored schedule

## 3. Documentation

- [x] 3.1 Amend ADR 0002 (the executor stays the factory's; automations keep their host and share the schedule mechanism), and add to `GLOSSARY.md` when to use an automation and when a factory schedule. Verify every file and function the texts name exists with `rg`
- [x] 3.2 Update `openwiki/architecture/pipelines-and-automation.md` and the "Single-instance assumption" comment of `automation-scheduler.ts` to say what still assumes one instance. Verify with `rg -n "Single-instance" packages/server/src`

## 4. Integration check

- [x] 4.1 Run `bun run lint`, `bun run typecheck`, the full server suite and `bunx fallow audit`; verify all pass
