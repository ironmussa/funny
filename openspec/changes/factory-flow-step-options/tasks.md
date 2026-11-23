# Tasks

## 1. Workflow schema and compiler

- [x] 1.1 Add `effort`, `thread` (`continue` | `new`), `prompt_file` (mutually exclusive with `prompt`) to `spawnAgentAction` and a flow-level `defaults` block in `packages/workflows/src/schema.ts`; verify with schema tests for both/neither prompt and unknown `thread` values
- [x] 1.2 Pass `stepId` (`<node>` or `<node>.before_retry`), `effort` and `thread` in `SpawnAgentOpts`, plus the flow's `defaults`, and widen `coercePermissionMode` to the full permission mode set; verify with compiler tests asserting the opts a fake provider receives for a node and a `before_retry`
- [x] 1.3 Implement `resolvePromptFiles(parsed, readFile)` with path normalization (refuse absolute, `..`, outside the flow dir) and a compile error when an unresolved `prompt_file` reaches the compiler; verify with unit tests for each refusal and for templating of a file prompt

## 2. Factory option resolution and validation

- [x] 2.1 Add `factory-step-options.ts` with `resolveStepOptions` (override → step → `defaults` → factory defaults, every field explicit) and unit tests covering precedence and no leak between steps
- [x] 2.2 Add `validateFactoryFlow` in `factory-flow.ts` (allowed fields, `autoEdit`/`plan` only, tool lists only on tool-policy providers, `thread: new` ⇒ `plan` and not first, provider/model validity, collected problems with step + field); verify with tests for every spec refusal scenario and that the current built-ins load
- [x] 2.3 Add the tool-policy provider table with a test that fails if `claude` / `pi` stop reading `disallowedTools`
- [x] 2.4 Read the default branch head commit once in `loadFactoryFlow`, read flow and prompt files at that ref, return `{ source, commit }`; verify with `factory-flow` tests using a fake contents reader (PR-branch edits ignored, missing prompt file refused)

## 3. Applying options in runs

- [x] 3.1 Send resolved options on the first thread's create body and on every follow-up body (`factory-thread-requests.ts` `sendFactoryFollowUp` takes an options object); verify with `factory-action-provider` tests asserting the bodies for implement, a later step and a fix step
- [x] 3.2 Implement `thread: new` launches (step title, recorded in `threadIds`, `followUp` still targets the first thread, adoption matches the full title); verify with tests for launch, resume replay without a second launch, and stop stopping the review thread
- [x] 3.3 Migration: `factory_runs.flow_source`, `flow_commit`, `step_options` and `factory_settings.step_overrides` in `server/src/db/migrate.ts` and both schemas; verify `bun run db:push` on a scratch DB and the migrate test
- [x] 3.4 Record source, commit and per-step options in `factory-flow-runs.ts` (append on step start, keep on resume, update commit on retry); verify with flow-run tests reading the row back
- [ ] 3.5 Update `openwiki/architecture/issue-factory.md` (accepted fields, precedence, `thread: new`, prompt files, recording) and verify the doc's file references exist

## 4. Step overrides and Validate flow API

- [x] 4.1 Add the strict `stepOverrides` schema to `@funny/shared/contracts/factory` and wire it through `factory-settings.ts` and the `factory` tRPC port (save needs `steer`); verify with `factory-trpc` tests: save, refusal of a permission-mode field, 403 without `steer`
- [x] 4.2 Read overrides at each agent step in the action provider; verify a test where an override saved mid-run applies to the next step only
- [x] 4.3 Add `factory.validateFlow` (`projectProcedure('view')`) answering problems or the step summary, unused overrides and "context replay" warnings; verify with tRPC tests for a parse error, a valid built-in and a stale override, and that no thread is started

## 5. Built-in flows and prompts

- [ ] 5.1 Add `packages/workflows/defaults/prompts/` (`implement.md`, `fix-ci.md`, `open-pr.md`) with the improved prompts, and switch `issue-to-pr` / `issue-to-merge` to `prompt_file`; verify `issue-to-merge.test.ts` and `catalog.test.ts` pass with updated expectations
- [ ] 5.2 Add the `pull-request` retry with the open-PR follow-up to both flows; verify a factory test where the first `create_pr` finds nothing and the second finds the PR, and one where both find nothing and the run fails with the existing reason
- [ ] 5.3 Extend the CI failure text with head SHA, check URL and failed GitHub Actions step, keeping `Failing checks` / `conflicts with its base` verbatim and the size bounded; verify with `factory-ci-actions` and `@funny/core/github-app` pull-request tests

## 6. Client

- [ ] 6.1 Factory settings: step overrides table (rows from Validate flow's agent steps; provider/model/effort selects; unused rows marked) with `data-testid`s, saving through `data/factory/` actions; verify with `ProjectFactorySetting.test.tsx`
- [ ] 6.2 Validate flow action showing problems (step, field, message) or the step summary with warnings; verify with a component test for both answers
- [ ] 6.3 Run row: flow source, short commit link and collapsible per-step options; verify with a `ProjectFactoryRuns` test and a story

## 7. Integration

- [ ] 7.1 Run `bun run lint`, `bun run typecheck` and the server, workflows and client test suites; all pass
- [ ] 7.2 End-to-end on a test repository whose `.funny/workflows/` flow adds an advisory `thread: new` step in `plan` mode: send an issue with it and an override `ci.before_retry → model: haiku`; confirm the run row shows each step's options and the new-thread step ran in plan mode on its own thread
