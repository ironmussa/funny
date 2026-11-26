# Tasks

## 1. Contracts and storage

- [x] 1.1 Add `needs_spec` to `FactoryRunState` and `FACTORY_RUN_HOLDABLE_STATES`, the `needs_spec` triage answer (`decisions`, `findings`), `factorySpecSchema`, `factorySpecResultSchema`, the stored `factoryRunSpecSchema`, the review `checklist`, and the `specStage` / `commitSpecPath` settings in `@funny/shared/contracts/factory`; verify with schema unit tests (valid draft, draft without validation refused, questions bounds)
- [x] 1.2 Add the migration for `factory_runs.spec`, `factory_settings.spec_stage` (default 0) and `factory_settings.commit_spec_path`, for SQLite and Postgres; verify `test-db` helpers create them and a settings round-trip test passes
- [x] 1.3 Map the new columns in the factory repositories and the `factory` tRPC port (settings read/save with `steer`, `commitSpecPath` refused when absolute or containing `..`); verify with port tests

## 2. Run state machine

- [x] 2.1 Add `needs_spec` to `FLOW_TRANSITIONS` (from `triaging` only), `approveSpec` (`needs_spec → requested`, keeping `queue_order`), `retriage` from `needs_spec`, and `reopenSpec` (from `requested` and the parked states) in `factory-runs.ts`, all compare-and-set; verify with the transition-table tests (every legal move, one illegal per state)
- [x] 2.2 Update the factory row in `docs/architecture/state-machines.md` and verify it names every new transition

## 3. Triage answer

- [x] 3.1 Offer `needs_spec` in the triage prompt only when `specStage` is on, and refuse it in validation otherwise (one re-emit, then the existing no-contract rule); verify with triage tests for both settings
- [x] 3.2 On `needs_spec`, store the answer, park the run in `needs_spec` with no comment on the issue, and hand off to the spec stage; never treat a `fromSpec` triage as superseded in `issueChangedSince`; verify with tests (no GitHub comment written, slot freed, edited issue keeps the approved spec)

## 4. Spec writer

- [x] 4.1 Create `factory-spec.ts`: launch the read-only spec thread (`[Factory spec] #N` title, role inputs: issue text, decisions, findings, previous spec on reopen), adopt it by title on resume, record `spec.threadId`, include it in `threadsOf`; verify with tests using the fake runner (thread is read-only, inputs not in the prompt)
- [x] 4.2 Handle completed turns of a spec thread from `onFactoryThreadTerminal`: read the result with `readRoleResult`, store it with an incremented `revision`, set `spec.problem` after a failed re-emit, Web Push the enabler; verify with tests for questions, draft, invalid twice, and a follow-up on the spec thread not taking the run over
- [x] 4.3 Keep the spec thread's worktree while `needs_spec` and release it on approval, retriage, hold and stop (`releaseRoleWorkspace`); verify with tests per exit
- [x] 4.4 Add the spec writer prompt (`READ_ONLY_SHELL_RULE`, narrow definition of a product decision, result format) and verify a prompt snapshot test

## 5. Approval and reopen

- [x] 5.1 Add `factory.approveSpec({ runId, revision })` (`projectProcedure('steer')`, browser session only): one compare-and-set writing `spec.approved`, the `fromSpec` triage contract and `requested`; 409 with the current run when the revision or state moved; audit record and `factory.spec_approved` activity; verify with port tests (approve, stale revision, wrong state, non-steer 403)
- [x] 5.2 Add `factory.reopenSpec({ runId })`: drop the approval, write `needs_spec`, send the revision follow-up on the kept thread (or start a new spec thread when its worktree is gone); verify with tests from `requested` and `waiting_human`, refused while in flight
- [x] 5.3 Extend approval requests with kind `spec` (created by `funny_factory_request_approval` on a `needs_spec` run with a draft, expiring when the revision changes) and make `funny_factory_run` return the spec and its approval; verify with `factory-agent-tools` tests that no tool path reaches `approveSpec` and the fitness check for the runner data channel still passes
- [x] 5.4 Document the spec stage in `openwiki/architecture/issue-factory.md` (A run, Role results, Operator controls, From a thread's agent) and verify the links resolve

## 6. Implementer and reviewer

- [x] 6.1 Fill a `spec` template variable from the stored approval in the action provider, add the spec section and fixed-decisions rule to `prompts/implement.md`, and the commit instruction when `commitSpecPath` is set; verify with a rendered-prompt test with and without a spec
- [x] 6.2 Warn in Validate flow when `specStage` is on and the first agent prompt never uses `{{spec}}`; verify with a `factory-flow-validation` test
- [x] 6.3 Pass the spec's validation items to the reviewer prompt, require a complete `checklist` (unanswered item → invalid result), append a `high` finding per unmet item before `reviewAllowsMerge`, and list the checklist in the PR review comment; verify with review tests (unmet item loops back, missing item asks again, run without spec unchanged)

## 7. Client

- [x] 7.1 Map `needs_spec` in `board-columns.ts` and `run-state-chip.ts`, and add the "why waiting" lines in `factory-run-labels.ts`; verify with `factory-board.test.ts` cases for questions and draft
- [x] 7.2 Add the run panel Spec section (questions + thread link, draft + Approve / Reopen spec, approved spec with who and when) through `data/factory/actions.ts` and `lib/api/factory.ts`, with `data-testid`s; verify with component tests including the 409 refresh
- [x] 7.3 Add the Spec stage and Commit spec rows to the project's Factory settings with `settings-index.ts` entries, and the en/es/pt translations; verify `bun run lint` (`fitness:settings-index`) passes

## 8. Integration

- [x] 8.1 Run an end-to-end server test: triage `needs_spec` → spec writer asks → follow-up answer → draft → approve → implementer prompt contains the spec → reviewer checklist with an unmet item loops back; verify it passes
- [x] 8.2 Run `bun run lint`, `bun run typecheck` and the factory test suites, and verify all pass
