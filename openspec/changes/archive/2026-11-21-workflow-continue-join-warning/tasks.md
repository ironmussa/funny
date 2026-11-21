# Tasks

## 1. Parser warnings

- [x] 1.1 Add `severity?: 'error' | 'warning'` to `WorkflowDiagnostic` and a shared `isErrorDiagnostic` helper (missing severity counts as error); verify with a unit test of the helper and `bun run typecheck`
- [x] 1.2 Add the continue-join check next to `graphIssues` in `packages/workflows/src/validate.ts` and return its output as `warnings` on the `ok: true` parse result; verify with parser tests for the four spec cases (dependent warned, explicit `all_success` silences, explicit `all_done` silences, `continue` without dependents is quiet) and one dependent with two `continue` dependencies getting a single warning
- [x] 1.3 Verify the bundled flows (`fusion`, `code-quality` and the rest under `packages/workflows/defaults/`) parse with zero warnings, as a test that iterates the defaults

## 2. API and loading

- [x] 2.1 Keep the warnings on the catalog entry and return them, with `severity: 'warning'`, from the runtime validate and definition routes in `packages/runtime/src/routes/workflows.ts`; verify with route tests that a flow with a warning returns `ok: true` plus the warning
- [x] 2.2 Log parse warnings at `warn` with flow name and path in the catalog, `factory-flow.ts` and the orchestrator `factory-workflow.ts` step; verify with a test per site that the logger receives the warning and the flow is still used

## 3. Editor

- [x] 3.1 Replace the four `diagnostics.length > 0` checks in `WorkflowsSettings.tsx` with `diagnostics.some(isErrorDiagnostic)` and render warnings with a warning style apart from errors; verify with `WorkflowsSettings.test.tsx` cases: warnings only keeps save and run enabled and shows the warning, one error disables both

## 4. Breaking-change documentation

- [x] 4.1 Add a line to the failure section of `openwiki/architecture/pipelines-and-automation.md`: dependents of a `continue` node on the default join are skipped, add `trigger_rule: all_done` to keep the old behavior, and the parser warns about it; verify the page renders and the rule matches the spec
- [x] 4.2 Write the "Breaking change" section for the `workflow-dag-engine` PR (before, after, migration rule, the warning that points at it) and keep it in this change's folder as `pr-breaking-change.md` until the PR is opened; verify it covers the three parts

## 5. Integration

- [x] 5.1 Run `bun run lint`, `bun run typecheck` and the workflows, runtime, server, orchestrator and client suites; verify all pass
