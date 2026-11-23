# Tasks

## 1. Run model: trigger, inputs, optional issue

- [x] 1.1 Add migration: `factory_runs.trigger_kind` (backfilled from `source`), `trigger_id`, `inputs`; restate `factory_runs_one_active_per_issue` with `issue_number > 0`; add `factory_runs_one_active_per_trigger`; create `factory_triggers`. Mirror it in `schema.sqlite.ts` / `schema.pg.ts` and the test-db helpers. Verify with a migration test that seeds an in-flight run per kind and checks each index refuses a duplicate
- [x] 1.2 In `factory-runs.ts`, map `issue_number = 0` to `issueNumber: null` on `FactoryRunView`, widen `FactoryRunSource`, accept `trigger` and `inputs` in `StartRunInput`, and return `factory/run-<id>` from `factoryRunBranch` without an issue. Verify with repository tests for start, read-back and the branch name of both kinds
- [x] 1.3 Add the terminal state `done` (from in-flight states, issueless runs only) to the run machine and to `docs/architecture/state-machines.md`. Verify with a transition test, including that an issue run cannot reach `done`
- [x] 1.4 Make `issueNumber` optional and add `trigger`, `triggerName` and `inputs` on the run in `contracts/factory.ts`; fix every server reader the type change breaks. Verify with `bun run typecheck` and the existing factory route tests

## 2. Subject and flow inputs

- [x] 2.1 Replace `FactoryRunJob.issue` with the `subject` union and build inputs in one `flowInputsOf(job)`, with factory inputs winning over recorded ones. Verify with unit tests for both subjects and for a recorded input named `repo`
- [x] 2.2 Narrow the issue-only steps (triage, review, regression proof, merge, dependencies) to take the issue subject as a parameter. Verify with `bun run typecheck` and the existing watcher and flow-run suites unchanged
- [x] 2.3 Add `validateFlowForSubject` to `factory-flow-validation.ts` (issue-only steps, uncovered required inputs) and call it at the start of a run, failing the run with the formatted problems. Verify with validation tests per rule and a flow-run test that fails before any thread starts

## 3. Schedule triggers on the server

- [x] 3.1 Add the triggers repository (`list`, `save`, `remove`, `takeDue` as a compare-and-set on `next_run_at`) with schedule validation through `parseAutomationSchedule` and input-name validation through `validateSecretName`. Verify with repository tests, including two concurrent `takeDue` calls where one wins
- [x] 3.2 On the watcher tick, take due triggers before `admitQueue`, insert their runs in `requested`, and record a `factory.trigger_skipped` server activity when the trigger index refuses one. Verify with watcher tests: an occurrence starts a run, a working previous run skips, a parked previous run does not block, a paused factory creates nothing, a missed occurrence is not replayed
- [x] 3.3 Admit an issueless `requested` run through the queue path (cap and order as a sent issue) and end it `done` or on its pull request. Verify with watcher tests for both endings and for a run waiting on a full cap
- [x] 3.4 Keep triggers when a factory turns itself off, and delete them with the factory. Verify with a lost-access test and a factory-delete test
- [x] 3.5 Document triggers in `openwiki/architecture/issue-factory.md` and add `Trigger` to `GLOSSARY.md`; verify the documented table and procedure names exist with `rg`

## 4. API

- [x] 4.1 Add `factory.triggers.list / save / remove` and `factory.runNow` to `@funny/api` and `trpc/ports/factory.ts` with `projectProcedure('steer')`, running `validateFlowForSubject` on save and on run-now. Verify with tRPC tests: 403 without `steer`, 404 for an unseen project, refusal naming the step or the input, and a successful run-now creating a `run_now` run
- [x] 4.2 Refuse run-now when the factory cannot work, with the queue's reasons. Verify with tests for paused, runner offline and App missing

## 5. Client

- [x] 5.1 Add triggers to `data/factory/` (query, save / remove actions that invalidate it) and `runNow`. Verify with data-layer tests using the entity's testing helpers
- [x] 5.2 Add the Triggers section to the factory settings with add / edit / remove, `data-testid` on every control, and entries in `settings-index.ts`. Verify with a component test and `bun run lint` (`fitness:settings-index`)
- [x] 5.3 Add the "Run a flow" dialog to the factory view: flow select and one field per declared input. Verify with a component test for a required input left empty and for a successful start
- [x] 5.4 Show issueless runs on the card, the list and the run panel by trigger name, list their inputs, omit the issue-only sections, and place `done` in the Done column. Verify with component tests for a scheduled card and a `done` run

## 6. Integration check

- [x] 6.1 Run `bun run lint`, `bun run typecheck`, the full server and client suites and `bunx fallow audit`; verify all pass
- [ ] 6.2 In a running app against a test repository, schedule a flow with one agent step and a `notify`, wait for an occurrence and confirm the run reaches `done` on the board; start the same flow with "Run a flow"; confirm `issue-to-merge` is refused for a schedule
