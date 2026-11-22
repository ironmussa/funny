# Proposal

## Why

Runs 208, 209 and 210 (pull requests #398, #399, #400) merged on their first green CI, with no
fix rounds and about a dollar each, yet nothing checked the quality of what they merged:

- **No review.** The only reviewer was CodeRabbit, which answered "review limit reached" with a
  `neutral` check; `wait_ci` counts neutral as passing, so the run merged unreviewed.
- **Unproven regression tests.** Only one of the three agents (#209) checked that its new test
  fails without the fix. A test that passes on the old code protects nothing, and CI cannot tell.
- **Unverified claims.** The three issues came from an automated review and said "verify the
  claim against `master` before any work" (#208: "Measure; then buffer"). The agents went
  straight to a fix.
- **Unquestioned scope.** #210 covers one of the issue's two cases and leaves a narrower race in
  place; its pull request argues the other case away, and nobody checked.

The review and triage gaps are designed in `factory-agent-roles` (reviewer and triage roles, a
merge that requires a `pass` for the head commit) and `factory-flow-step-options` (separate
read-only review threads, shared prompt files). Nothing proposed so far proves that a run's
tests catch the bug it fixes, and an agent's own claim that it did is not evidence. This change
adds that proof as a gate the system runs itself, and tightens what the implementer is asked to
do until triage and review land.

## What Changes

- **Regression proof gate.** A new `regression_proof` flow step runs, on the run's runner and
  never in the agent's thread, the tests the pull request changed: against the pull request's
  base without its fix they SHALL fail, and against its head commit they SHALL pass. The step
  is configured in the flow file as a list of rules (test file globs, the command with a
  `{{files}}` placeholder, the directory it runs in), so a monorepo whose packages use
  different test commands is covered, and the configuration is reviewed on the default branch
  like the rest of the flow. Test support files the pull request changes (fixtures, helpers,
  snapshots, by configured globs) are copied to the base with the tests, so a test does not fail
  there only because its fixture is missing; production code is never copied.
- **The proof runs as a job, not as one request.** The server starts it on the runner and polls
  for its result, because a server → runner request ends after 30 seconds and a proof takes
  minutes. A start for a commit whose proof is already running joins it, so a server restart
  resumes instead of running it twice.
- **Findings loop back to the implementer.** "No test changed" (when a test is required), "the
  tests pass without the fix", and "the tests fail with the fix" go to the implementer's thread
  as a follow-up, like red CI; when the step's attempts run out, the run parks in
  `waiting_human` with the proof on the run.
- **A proof is bound to one commit, and `merge` keeps it current.** The result is stored per
  head commit. The built-in order is `pull-request → regression-proof → ci → merge`; when a CI
  fix moved the head after the proof, `merge` runs the proof again on the current head instead of
  parking, and merges only if it passes.
- **The gate is on by default and cannot be removed silently.** `merge` requires a passing proof
  for the head commit in every flow, whether or not the flow declares the step. A flow opts out
  only with `require_regression_proof: false` on its `merge` step, and flow validation warns
  about it.
- **Configuration is required, and checked before a run starts.** No test command fits every
  repository, so the built-in flows ship the step without rules and every repository supplies
  its own in its flow file. A factory whose flow requires the proof and has no rules admits no
  issue: the issue waits in the queue and the factory shows "regression proof not configured"
  in its settings and queue, instead of spending a run that would park at `merge`.
- **The proof is a GitHub check, so GitHub enforces it per commit.** The server publishes every
  verdict as a check run named `funny/regression-proof` on the proved commit, created by the
  deployment's GitHub App. A repository that makes it a required check of its default branch,
  pinned to that App, gets the rule from GitHub itself: a commit without a passing proof cannot
  be merged by auto-merge or by a person. The agent cannot write it: only an App creates check
  runs, the token an agent gets has `checks: read`, and the pin to the App rules out a workflow
  job of the same name.
- **Auto-merge only where GitHub holds the gate.** `merge` merges the proved commit directly
  when GitHub allows it. When it does not, `merge` enables auto-merge only if the check is
  required on the base branch and pinned to the App; the run then waits, and a commit pushed
  meanwhile is proved again and gets its own check. Where the check is not required, `merge`
  never enables auto-merge (GitHub would merge a later, unproven commit) and the run parks,
  saying how to require the check.
- **A claim that does not hold ends without a pull request.** When the implementer verifies the
  issue's claim and it does not hold, it pushes nothing and says so; the `pull-request` step then
  posts that explanation on the issue and parks the run in `waiting_human` with the reason
  `no change`, instead of failing with a generic error.
- **Stricter built-in implement prompt.** Find the root cause; cover every case the issue names
  or say in the pull request why one is left out; consider concurrency and edge cases; when the
  issue asks to verify or measure first, do it and report the result; run the full test suite of
  each package touched; state in the pull request how the regression test was shown to fail
  without the fix.
- **The proof is visible.** The run row and the pull request body show the proof's verdict, the
  files and commands it ran, and its output tail.

Out of this change: merge queue support. Repositories with a merge queue park at `merge` or opt
out; the intended design is recorded in `design.md` (Future Work) for a separate change.

Also out of this change: the rule that an external reviewer's check (CodeRabbit) is not a review. It
is a rule about the run's review state, which `factory-agent-roles` introduces, and belongs
there with a test.

## Capabilities

### New Capabilities

<!-- None: these are the issue factory's behaviour. -->

### Modified Capabilities

- `issue-factory`: a `regression_proof` step and its default-on gate on `merge`, the proof bound
  to the head commit, the "no change" outcome of the `pull-request` step, and the built-in
  flows' implement prompt and step order.

## Impact

- **Coordinates with** `factory-agent-roles` (the proof becomes reviewer input and a merge
  precondition next to the review `pass`; its `needs_info` state takes over the "no change"
  outcome; the external-review rule moves there) and `factory-flow-step-options` (the stricter
  prompt moves into its shared `prompts/implement.md` when that lands). Ships without either.
- **`packages/workflows`**: `regression_proof` action schema, `require_regression_proof` on
  `merge`, validation, built-in `issue-to-merge` / `issue-to-pr` step order and prompt text.
- **`packages/server/src/services/factory/`**: action provider (`regressionProof` start and
  poll through the enabler's certified runner requests, findings as a follow-up, the "no change"
  outcome of `createPr`), `factory-runs.ts` (proof per head commit), `merge` precondition and
  pinned merge, metrics.
- **`packages/runtime`**: thread routes that start a proof job and report its state; the job
  runs commands in a temporary worktree at a given commit with files taken from another commit,
  with a timeout, always removing the worktree.
- **`@funny/core/git`**: helpers to create a detached temporary worktree and copy files from a
  commit into it. **`@funny/core/github-app`**: a pinned merge that never enables auto-merge,
  check run creation, and reading whether a check is required on a branch and by which App.
- **GitHub App permissions**: the App needs `checks: write` (today `checks: read`). Existing
  installations must accept the new permission; until one does, the check is not published and
  that repository behaves as "check not required". Tokens handed to sandboxes and agents keep
  `checks: read`.
- **Database**: `factory_runs.regression_proof` (JSON, per head commit); migration in
  `server/src/db/migrate.ts`, both schemas.
- **Client**: the run row shows the proof verdict and its details.
- **Behaviour change for every factory**: once the gate is on, a repository admits issues only
  after its flow file has proof rules or opts out explicitly, whether it used the built-in flow
  or its own copy.
- **Docs**: `openwiki/architecture/issue-factory.md`, `docs/guides/issue-factory.md` (configuring
  the step), and the entries this resolves in `openwiki/architecture/issue-factory-improvements.md`.
