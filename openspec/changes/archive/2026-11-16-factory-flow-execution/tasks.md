# Tasks

## 1. `wait_ci` + `merge` node types in `@funny/workflows`

- [x] 1.1 Added `wait_ci` and `merge` action schemas + keys to `schema.ts` (wait_ci: timeout_ms/interval_ms/required_checks; merge: method/delete_branch/auto), run-implicit like set_status. Schema-driven parse tests exercise them via the compiler suite.
- [x] 1.2 Added `WaitCiOpts`/`MergeOpts` and `waitCi`/`merge` to the `ActionProvider` contract (`compiler/action-provider.ts`); the whole-repo typecheck confirmed the break surfaced at every implementer and is now absorbed (0 new errors).
- [x] 1.3 Bound both nodes in `compiler/yaml-compiler.ts` (dispatch to `provider.waitCi`/`merge`, `!ok` throws a step error so `retry`/`on_error` act). New `yaml-compiler.test.ts` case: green → both dispatched with mapped opts; red wait_ci → run not completed and merge never called.
- [x] 1.4 Implemented the two methods on `RuntimeActionProvider` and the orchestrator's `WorkspaceActionProvider` as explicit "unsupported in this context" results (CI/merge belong to the factory's server provider), and added defaults to all runtime `ActionProvider` test fakes. The harness `ActionProviderLike` is an independent structural type and needs no change. Typecheck + workflows/runtime pipeline + scheduler suites green.

## 2. Server CI/merge over the GitHub App token

- [x] 2.1 Moved the orchestrator's pull request logic to `@funny/core/github-app` (`createPullRequestCi` over `createRepoGithub`, any repository token source; orchestrator re-pointed, its suite unchanged, core unit tests added) and added the server's `FactoryPullRequests` port (`services/factory/factory-pull-requests.ts`): CI state and merge (only on green, preferred method, optional branch deletion) with the App token capped by the enabler (`accessCapToken`; read level cannot merge) and actionable access errors. Tests over a fake GitHub REST: green/red/pending, merge refused when not green (no merge call), merge + branch deletion, read-only enabler, App not installed. The CI timeout lives in `waitCi` (2.2).
- [x] 2.2 `services/factory/factory-ci-actions.ts`: `waitCi` (interruptible poll to green / red / conflict / timeout; a head with no checks is pending for a 2-minute grace, then "no CI"; `required_checks` refused as not yet supported) and `merge` (only on green; `markMerged` called only when GitHub merged), with `ActionResult`-shaped results for the group 3 provider. Tests: the three verdicts, the grace, stop, both merge outcomes, no PR, missing App access.

## 3. Server flow execution as the enabler

- [x] 3.1 (`factory-action-provider.ts`: agent step = thread via `startThreadOnRunner` for the enabler, resolved from its persisted terminal status; agent steps numbered in call order so a resumed run replays recorded threads; git_commit/git_push acknowledged, create_pr finds the agent's PR by the run branch, wait_ci/merge over the capped App token; run_command/approvals refused.)
- [x] 3.2 (`factory-flow-runs.ts` runs the compiled flow via `runPipeline`; progress → `factory_runs`; completed → waiting_human unless merged; failed before any agent → run dropped; watcher tests drive implement → PR → CI → merge, red CI, no PR, auto-merge.)
- [x] 3.3 (`factory-flow.ts` + `factory-repo-reads.ts`: contents API pinned to the default branch, `.yaml` then `.yml`, invalid copy fails the run, else built-in; test that the PR-branch copy is never requested.)
- [x] 3.4 (`factory-runs-completion.ts` removed: `notifyTerminalStatusPersisted` calls `signalThreadTerminal`, waking the step, which re-reads the DB; a 30 s poll backs it up; restart → next tick resumes in-flight runs; missing / >24 h thread fails the step. Tests: signal resume, missing, stale, stop, resume-after-restart without relaunch.)

## 4. CI-driven fix loop + built-in flow

- [x] 4.1 (fix loop: wait_ci retry 3 looks, should_retry on red/conflict only, before_retry fix agent pushes to the run branch; tests in workflows issue-to-merge.test.ts + watcher) Add `defaults/issue-to-merge.yaml` (implement → checks → PR → `wait_ci` → `merge`) with the CI fix loop expressed via `wait_ci` + `retry.before_retry`, and make it the default `flowName`; verify a catalog/compile test loads it and a flow test exercises red→fix→green→merge and retry-exhaustion→no-merge (spec: fix loop requirements).
- [x] 4.2 (both built-ins listed and compile; NOTE: factory-issue tells the agent not to push, so on the server it ends with no PR found) Keep `factory-issue.yaml` (stops at draft PR) available for human-merge deployments; verify it still compiles and the two built-ins are both listed by the catalog.

## 5. Verification

- [x] 5.1 `bun run lint` and `bun run typecheck` green across `@funny/workflows`, `packages/server`, and `packages/runtime`.
- [x] 5.2 `bun run format` (oxfmt) on touched files.
- [x] 5.3 `openspec validate factory-flow-execution --strict` passes.
