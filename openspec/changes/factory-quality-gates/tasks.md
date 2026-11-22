# Tasks

## 1. Git and GitHub helpers (core)

- [x] 1.1 Add `@funny/core/git` helpers: create a detached temporary worktree at a commit under
      the worktree root with a fixed name prefix, copy files from another commit into it, list
      files changed between two commits (added or modified only), and remove a temporary
      worktree; all return `ResultAsync`, reject `-`-prefixed refs and paths outside the
      worktree. Verify with tests against a real git repo (create, copy, diff filter, remove,
      refusal of a hostile ref).
- [x] 1.2 Add to `@funny/core/github-app` a merge option that merges a given head SHA directly
      and never enables auto-merge (returns `not-mergeable` with GitHub's reason instead), a
      query for whether a branch exists with commits ahead of the default branch, creation of a
      check run on a commit, and a query for whether a named check is required on a branch and
      from which App (rulesets and classic protection). Verify with
      tests on the fake GitHub transport: pinned merge, refusal without enabling auto-merge, a moved head, branch absent / equal / ahead, check run creation and its permission
      error, and the required-check query (required from the App, required from any source, not
      required).

## 2. Runner proof job

- [x] 2.1 Implement the proof service: fetch, merge-base, changed files assigned to the first
      matching rule, base phase in a temporary worktree with the project's worktree setup and the
      test and support files copied in (at least one command must fail), head phase in the
      thread's worktree when clean at `headSha` or else a temporary one (every command must
      pass), `{{files}}` shell-quoted and relative to the rule's `cwd`, time limit with the
      process group killed, temporary worktrees removed in `finally`; returns
      `{ verdict, finding, files, commands, baseSha, outputTail }`. Verify with tests on a real
      repo: pass, passes-on-base, passes-on-base with a changed fixture copied, fails-on-head,
      two rules with different `cwd`, no test changed, setup failure, timeout, and no worktree
      left behind in every case.
- [x] 2.2 Add the job registry (in memory, one job per thread, idempotent start per head SHA, a
      new head stops and replaces the old job) and the routes
      `POST /api/threads/:id/regression-proof` (answers `running` at once) and
      `GET /api/threads/:id/regression-proof/:proofId` (`running` / `done` / 404), with body
      schemas in `validation/schemas.ts`: owner only (no steer delegation), refuses scratch
      threads and threads without a checkout. Verify with route tests for each refusal, a
      repeated start joining the job, a new head replacing it, and an unknown job answering 404.
- [x] 2.3 Sweep leftover proof worktrees (by prefix) at runner start. Verify with a test that
      plants one and starts the sweep.

## 3. Flow schema

- [x] 3.1 Add the `regression_proof` action to `packages/workflows` (`rules` of
      `{ globs, command, cwd? }`, `support_globs`, `require_test` `always | labels | never`,
      `labels`, `timeout_ms`) and to the action catalog; validation refuses a rule whose command
      has no `{{files}}` and a `cwd` outside the repository; `rules` may be empty (not
      configured). Verify with
      schema and validation tests, and that the existing flows still parse.
- [x] 3.2 Add `require_regression_proof` (default `true`) to the `merge` action; flow validation
      reports `false` as a warning and exports a `isProofReady(flow)` predicate (no `merge`,
      the opt-out, or at least one rule) and reports a flow that is not proof-ready as a warning
      that its factory will admit nothing. Verify with validation tests for both
      warnings.

## 4. Factory server

- [x] 4.1 Add `regressionProof` to the factory action provider: resolve `require_test` from the
      issue's labels, start the job on the run's implementing thread and poll it through
      `withRunnerFor` as the enabler (extend `factory-thread-requests.ts`), restart once on 404,
      give up as `fail` after the time limit, map the verdict to `ok` or a `Regression proof: …`
      error, and record it. Verify with provider tests for each verdict, the label rule, a proof
      longer than one request deadline, a replayed step joining the job, a job lost once and
      twice, and a runner that is offline (fail, not pass).
- [x] 4.2 Store the proof in `factory_runs.regression_proof` (JSON: head SHA, verdict, finding,
      files, commands, base SHA, output tail, time); migration in `server/src/db/migrate.ts` and
      both schemas. Verify with a repository test and the migration test.
- [x] 4.3 Make `merge` enforce the proof unless `require_regression_proof: false`: read the head
      SHA, use the stored proof when it is for that SHA, otherwise run the proof with the flow's
      configuration (no configuration: `fail`, "no regression proof configured"), park in
      `waiting_human` without an allowed verdict, and merge the proved SHA with the pinned merge
      of 1.2. Verify with watcher tests: current passing proof, proof for an older commit that
      passes again, one that fails, no proof, a flow without the step, the opt-out (today's
      behaviour, auto-merge included), GitHub refusing a direct merge, and a head that moves
      before the merge.
- [ ] 4.4 Publish every proof as the `funny/regression-proof` check run with a server-only token
      that asks for `checks: write` (add it to the App manifest; `SANDBOX_PERMISSIONS` keeps
      `checks: read`), and show a missing permission in the GitHub App settings. In `merge`, when
      a direct merge is refused, enable auto-merge only when the check is required on the base
      branch from this App, else park with how to require it. In the watcher's pass over parked
      runs, re-prove and publish for a run waiting on auto-merge whose head moved. Verify with
      tests: check published per verdict, a publish failure does not fail the run, a sandbox
      token's permissions unchanged, auto-merge enabled only when held (pinned to the App), a new
      head re-proved while waiting, and a failing re-proof leaving the finding on the run.
- [x] 4.5 Give `createPr` the "no change" outcome: with no open pull request and no commits ahead
      on the run's branch, post the implementing thread's final message on the issue, remove the
      run's worktree and park in `waiting_human` with reason `no change`; with commits ahead,
      today's error. Verify with provider tests for both cases and that a parked `no change` run
      is not admitted again.
- [ ] 4.6 Check `isProofReady` at admission in the watcher: a flow that is not proof-ready admits
      nothing, leaves the issue queued with no slot, and records the factory blocker "regression
      proof not configured"; in-flight runs continue. Expose the blocker in the `factory` tRPC
      settings and queue responses. Verify with watcher tests: not configured (no run, blocker
      set), rules added (admitted, blocker cleared), opt-out (admitted), and a run in flight
      untouched.
- [ ] 4.7 Count proofs with `factory.integration_event` (`regression_proof_pass`,
      `regression_proof_fail`, `regression_proof_skipped`, `no_change`). Verify in the provider
      tests.

## 5. Built-in flows and prompts

- [x] 5.1 Add the `regression-proof` step (no rules; rule examples for common test runners in
      comments, its retry and inline fix prompt) between `pull-request` and `ci` in
      `issue-to-merge.yaml` and `issue-to-pr.yaml`, with `require_test: labels` and
      `labels: [bug]`. Verify with the built-in flow tests and a watcher test that runs the
      built-in flow end to end with a fake proof, including a CI fix round followed by the
      re-proof in `merge`.
- [x] 5.2 Rewrite the implement prompt of both built-ins as the spec requires (root cause, every
      case or a reason, concurrency and edge cases, verify or measure first and push nothing when
      the claim does not hold, full test suite of touched packages, how the test was shown to
      fail). Verify with a test on the prompt's required instructions.
- [ ] 5.3 Add this repository's own `.funny/workflows/issue-to-merge.yaml` rules for its packages
      (the client's `--isolate`, the `--parallel` packages, default `bun test`). Verify by
      running the proof locally against pull request #399's commits (expected `pass`).
- [ ] 5.4 Document the step, the default-on gate, the opt-out, the check run and how to require it
      (pinned to the App; when not to: merge queue, pull requests from people) and the "no change" outcome in `docs/guides/issue-factory.md`, and the run shape in
      `openwiki/architecture/issue-factory.md`; remove what this resolves from
      `openwiki/architecture/issue-factory-improvements.md`. Verify the links resolve.

## 6. Client

- [ ] 6.1 Show the proof on the factory run (verdict, finding, files, commands, output tail) the
      `no change` reason, and the "regression proof not configured" blocker in the factory
      settings and the queue view, using shadcn components and `data-testid`s. Verify with a
      component test for pass, fail, skipped, no change and the blocker.

## 7. Rollout and integration

- [ ] 7.1 Before turning the gate on, list the enabled factories whose repository has its own
      flow copy or relies on auto-merge, ask each installation to accept `checks: write`, and
      record in the change who was told.
- [ ] 7.2 Run a built-in flow against real issues on a test repository: a fix with a real
      regression test merges; a test that passes without the fix gets a fix round and, unfixed,
      parks the run; an issue whose claim is false ends in `no change` with a comment. Record the
      outcomes in the change.
- [ ] 7.3 Move the external-review rule ("an external reviewer's check is not a review") into
      `factory-agent-roles`' spec delta with a scenario. Verify with
      `openspec validate factory-agent-roles --strict`.
- [ ] 7.4 Before archiving, merge this change's `merge` requirement text with
      `factory-agent-roles`' if that change archived first. Verify with
      `openspec validate factory-quality-gates --strict`.
