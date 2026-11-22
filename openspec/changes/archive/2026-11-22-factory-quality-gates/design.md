# Design

## Context

- A factory run executes its flow on the server through the factory `ActionProvider`
  (`factory-action-provider.ts`). Agent steps are threads on the enabler's runtime; `wait_ci`
  and `merge` call GitHub with the App token. `run_command` is refused: the server has no
  checkout.
- The server reaches a run's runner only through `withRunnerFor` and the certified sink, signed
  as the enabler (`factory-thread-requests.ts` already does this for follow-ups, stops and the
  merge cleanup). A thread route resolves to the thread's own runner: its project's runner, or
  its sandbox runner for a sandbox thread.
- A server → runner request has a deadline of 30 seconds by default
  (`grpc/runner-request-adapter.ts`).
- A step that fails with an error matching `retry.should_retry` runs `retry.before_retry` (a
  follow-up on the implementing thread) and is tried again. A flow that fails after its pull
  request is open parks in `waiting_human` (`settle` → `park`); before that it ends `failed`.
- `merge` checks the pull request's checks once, when it starts; it does not wait. It merges
  directly with the head SHA pinned (`mergeNow`), or enables GitHub's auto-merge when the
  repository allows it, after which GitHub merges whatever the head is once checks are green.
- `createPr` fails with "No open pull request from the branch …" when the agent opened none.
- `factory-agent-roles` (not implemented) adds triage and reviewer roles, deterministic checks
  before review, and a `merge` that re-verifies its preconditions on entry for the head commit.
  It modifies the same `merge` requirement as this change.

## Goals / Non-Goals

**Goals:**

- A proof the system runs itself, whose verdict an agent cannot write.
- The same code path for local-worktree and sandbox runs.
- Fail closed: a missing, stale or errored proof never lets a run merge, and removing the step
  from a flow file does not remove the gate.
- A normal run (a CI fix round included) reaches `merge` without a person.

**Non-Goals:**

- Judging whether the test is a good test (that is the reviewer's job in `factory-agent-roles`).
- Mutation testing or coverage gates.
- Running the full suite in the proof; CI does that.

## Decisions

### 1. The proof is a job on the thread's runner, started and polled through thread routes

- `POST /api/threads/:id/regression-proof` with `{ headSha, defaultBranch, rules, supportGlobs,
  timeoutMs }` starts the job and answers at once with `{ proofId, state: 'running' }`. A start
  for a `headSha` whose job is running or finished on this runner answers with that job (the
  start is idempotent per thread and head).
- `GET /api/threads/:id/regression-proof/:proofId` answers `{ state: 'running' }` or
  `{ state: 'done', result }`; 404 when the runner does not know the job (it restarted).

The server's `regressionProof` action starts the job, then polls every few seconds until `done`
or until `timeoutMs` plus a margin has passed (then the verdict is `fail`, finding `timeout`).
On a 404 it starts the job again, once. A server restart replays the step: the start joins the
running job. Every request is short, so the 30-second deadline is never the limit.

Both are thread routes, sent as the enabler through `withRunnerFor` with the thread as the
routing target, like a follow-up, so a sandbox run's proof runs on its sandbox runner and a
local run's on the enabler's runner, with no branch on runtime at the call site
(`thread-context` rule). The routes accept only the thread's owner (no steer delegation),
refuse scratch threads, and refuse a thread with no checkout. The runner computes the base and
the files itself from git; the server sends the flow's commands, never file paths.

The runner keeps jobs in memory (one per thread; a new head replaces the old job and stops its
processes). Nothing about a proof is authoritative on the runner: the verdict the server
stores is the one it read from `done`.

_Alternatives:_ one long request with a raised deadline (holds a tunnel request for ten minutes
and dies with either process); a new `data:*` message from the runner (needs a new data-scope
rule and an ownership check for a result the server can simply read); a GitHub Actions job in
the repository (not generic, and no structured verdict); asking the agent to run it and report
(an agent's claim is exactly what this change does not trust).

### 2. Base phase in a temporary worktree; head phase in the thread's worktree

- **Setup:** both phases run in detached temporary worktrees under the project's worktree root,
  prepared alike: the step's `setup_command` when set, else the head checkout's project
  configuration setup (its `postCreate` commands, e.g. `bun install`, as a thread worktree). A
  failing setup command fails the proof as an environment failure.
- **Head first:** a temporary worktree at `headSha`; every command must pass, twice (a test that
  passes once and fails once is flaky and proves nothing). When the head fails, the base says
  nothing, so it is not run.
- **Base:** `base = git merge-base origin/<defaultBranch> <headSha>` after a fetch, so commits
  merged to the default branch since the run started do not change the result. A temporary
  worktree at `base` gets the changed test files and changed test support files from `headSha`
  (`git checkout <headSha> -- <files>`). At least one command must fail by an assertion: a run
  that times out, or whose output says a test file could not load (missing module, syntax
  error), is inconclusive and fails the proof.
- **Budget:** `timeout_ms` bounds the whole proof on the runner (setup and every run of both
  phases); the server waits that long plus a minute, and stops the runner's job when it gives up
  or the run is stopped.
- **Verdicts the agent can fix** (`failureKind: test`: fails on the head, flaky, passes on the
  base, inconclusive on the base, no test when one is required) are retried with the
  implementer; environment failures (setup, git, time, the runner) are not.
- Both temporary worktrees are removed in a `finally`, including on timeout (the process group is
  killed first). Before a runner process's first proof in a project, a sweep removes the leftovers
  of a killed process by their name prefix.

_Why both phases in temporary worktrees?_ It doubles the setup time (installs) on every proof,
but the thread's worktree is not prepared like a fresh base checkout (its dependencies, build
output and untracked files differ), and such a difference can make the base fail for a reason
that is not the bug. Two checkouts prepared alike leave the code as the only difference. _Why not the base phase in the
thread's worktree (stash, checkout base)?_ It mutates the checkout the run's next step uses, and
a crash halfway leaves it on the wrong commit; the branch guard would then refuse the run.

### 3. Rules map changed test files to commands; support files travel with the tests

Changed files are `git diff --name-only --diff-filter=AM <base> <headSha>`.

- A **rule** is `{ globs, command, cwd? }`. Each changed file goes to the first rule whose globs
  match it; a rule with at least one file runs its `command` in `cwd` (default: the repository
  root) with `{{files}}` replaced by the shell-quoted paths relative to `cwd`. A changed file
  that matches a test glob of no rule cannot happen (rules are the definition of "test file").
- **`support_globs`** (default: `**/__fixtures__/**`, `**/fixtures/**`, `**/__snapshots__/**`,
  `**/__mocks__/**`, `**/test-utils/**`, `**/testing/**`) name files copied to the base with the
  tests but never run. Without them a test whose fixture the pull request also changes fails on
  the base for that reason, and the proof would pass on a test that catches nothing.
- The base phase requires at least one rule's command to fail; the head phase requires every
  rule's command to pass.
- Deleted test files are ignored (the test-weakening check in `factory-agent-roles` owns
  deletions).

There is no built-in default command: the project config has no test command, and a guessed one
would give a wrong verdict. A flow that does not configure the step has no rules; it is not admitted
(decision 8), and a run already in flight gets `fail` with the finding "no regression proof
configured" at `merge` (decision 6).

### 4. The flow file configures it; the commands are reviewed like the rest of the flow

```yaml
- id: regression-proof
  depends_on: [pull-request]
  regression_proof:
    rules:
      - globs: ['packages/client/**/*.test.ts', 'packages/client/**/*.test.tsx']
        cwd: packages/client
        command: 'bun test --isolate --timeout 20000 {{files}}'
      - globs: ['**/*.test.ts']
        command: 'bun test {{files}}'
    support_globs: ['**/__fixtures__/**', '**/testing/**']
    require_test: always # always (default) | labels | never
    exempt_labels: [docs, chore] # issues that need no test
    setup_command: 'bun install --frozen-lockfile' # optional; default: the .funny.json postCreate
    timeout_ms: 600000
  retry:
    max_attempts: 3
    should_retry: "$contains(error, 'Regression proof failed')"
    before_retry:
      prompt: |
        The regression proof of the pull request from `{{branch}}` failed:
        {{LAST_ERROR}}
        Fix the test (it must fail without your fix and pass with it), commit and push.

- id: ci
  depends_on: [regression-proof]
  wait_ci: {}
  # … the existing fix loop

- id: merge
  depends_on: [ci]
  merge: { method: squash, delete_branch: true }
```

The fix prompt is inline until `factory-flow-step-options` adds `prompt_file`; then it moves to
`prompts/regression-proof-fix.md`, shared by both built-in flows.

The commands come from the default branch's flow file, so they have the trust of everything else
in that file; they run on the run's runner, where the agent already runs arbitrary commands.

### 5. Order: proof, then CI, then a merge that keeps the proof current

The proof and CI each have a fix loop that pushes commits, and each commit invalidates the
other's result. Three orders were considered:

- _Parallel:_ two loops send follow-ups to the same thread at once. Refused.
- _CI, then proof:_ a proof fix leaves CI pending, and `merge` does not wait. Refused.
- **Proof, then CI (chosen):** the proof is local and fast, so the test is settled before CI
  time is spent. A CI fix then moves the head; `merge` handles that (decision 6) by running the
  proof again on the head it is about to merge. A CI fix rarely breaks the proof; when it does,
  the run parks with the finding.

Findings use the existing retry loop: the action returns `ok` for `pass`/`skipped` and an error
starting with `Regression proof:` for a finding, so the step plugs into `retry.should_retry` /
`before_retry` like `wait_ci`, and an exhausted loop parks the run through the existing `park`.
Every verdict is written to `factory_runs.regression_proof` as `{ headSha, verdict, finding,
files, commands, baseSha, outputTail, ranAt }` (the last one per run; the history is in the step
journal).

### 6. `merge` requires the proof by default, re-runs a stale one, and pins the commit

On entry, unless the step sets `require_regression_proof: false`:

1. Read the pull request's head SHA.
2. If the stored proof is for that SHA: `pass` (or `skipped` with no test required) continues;
   `fail` parks.
3. If there is no proof for that SHA (a later commit, or a flow without the step): run the proof
   now with the flow's `regression_proof` configuration, store it, and apply rule 2. A flow
   with no `regression_proof` step has nothing to run: the verdict is `fail`, finding "no
   regression proof configured", naming the two ways out (add the step, or opt out). No fix loop here: a finding at this point parks the run.
4. Merge **that SHA** with `mergeNow`. A head that moved between the check and the merge makes
   the pinned merge fail, and the run parks.
5. When GitHub refuses a direct merge (a required review, checks still running), auto-merge is
   enabled only where GitHub itself holds the gate (decision 9); otherwise the run parks with
   GitHub's reason and how to require the check.

The gate does not depend on the flow declaring the step, so deleting the step from a repository
flow changes where the proof runs, not whether. Flow validation reports
`require_regression_proof: false` as a warning, the same treatment `factory-agent-roles` gives
`require_review: false`.

`issue-to-pr` has no `merge`; its `regression-proof` step and fix loop still run, and the proof
shows on the run and in the pull request body for the person who merges.

### 7. "No change" is an outcome of the `pull-request` step

The implement prompt tells the agent to push nothing and explain when the issue's claim does not
hold. `createPr`, on finding no open pull request, asks GitHub whether the run's branch exists
with commits ahead of the default branch:

- **It does:** the agent did work but opened no pull request; today's error, unchanged.
- **It does not:** outcome `no change`. The server posts the implementing thread's final message
  on the issue (as the App, prefixed with a fixed line saying the factory made no change),
  removes the run's worktree and parks the run in `waiting_human` with the reason `no change`,
  so the issue is not picked up again and a person decides to close or reword it.

No new run state: `waiting_human` already means "a person decides". When `factory-agent-roles`
lands, triage catches most of these earlier and its `needs_info` state replaces this parking.

### 8. Every repository configures its proof, and admission checks it

No command fits every repository, so the built-in flows ship the `regression-proof` step with
no rules, and each repository supplies its own in `.funny/workflows/<flow>.yaml` on the default
branch. A flow is **proof-ready** when its `merge` does not require the proof
(`require_regression_proof: false`, or no `merge` step) or its `regression_proof` step has at
least one rule.

The watcher already loads the flow from the default branch before admitting an issue. A flow
that is not proof-ready admits nothing: the issue stays in the queue, holding no slot, and the
factory records the admission blocker "regression proof not configured" with the two ways out.
The factory settings and the queue view show that blocker, so the enabler sees it when turning
the factory on, not after a run has spent an agent and a CI cycle to park at `merge`. Runs
already in flight are not stopped; they meet the `merge` rule of decision 6.

_Alternative:_ rules in the project's `.funny` config, read by the runner. Refused for now: the
server has no checkout to check it at admission, and a second place for flow behaviour splits
what the default branch reviews.

### 9. The verdict is a check run of the App; auto-merge only where it is required

**Publishing.** After every proof the server creates a check run `funny/regression-proof` on
`headSha` with the App's installation token: `success` for `pass` and for an allowed `skipped`
(the summary says which), `failure` otherwise, with the finding, files, commands and output tail
in the summary. It is the same record as `factory_runs.regression_proof`, shown where the pull
request is read. Publishing is best effort for the run (a failure to publish is logged and
counted, and makes the repository count as "check not required" for this merge); the stored
proof stays the server's own source for `merge`.

**Why a check run and not a commit status.** Anyone with write access can post a commit status,
including an agent using the owner's token. A check run can only be created by a GitHub App, and
a branch rule can require the check _from one App_. Tokens minted for sandboxes and agents keep
`checks: read` (`SANDBOX_PERMISSIONS`); only the server's own token for this call asks for
`checks: write`. The pin to the App matters: without it a workflow job named
`funny/regression-proof` (the agent's token has `workflows: write`) would satisfy the rule.

**"Held by GitHub".** Before enabling auto-merge the server reads the base branch's rules
(rulesets and classic protection). The gate is held by GitHub when `funny/regression-proof` is a
required check there **and** its source is this deployment's App. Required without the pin
counts as not held.

**Auto-merge.** Held: `merge` enables auto-merge and the run parks in `waiting_human` as an
auto-merge run does today (the watcher closes it as `merged` when GitHub merges). The watcher's
pass over parked runs gains one duty: for a run waiting on auto-merge whose pull request head is
not the proved commit, run the proof on the new head and publish its check. GitHub does not
merge that commit before the check exists and passes, so there is no window to race. A failing
re-proof leaves a failing check (GitHub does not merge) and the finding on the run; no fix loop
at this point. Not held: no auto-merge, the run parks with GitHub's reason and the instruction
to require the check.

**Merge queue.** The queue builds and checks its own merge commit, which has no check run, so a
required `funny/regression-proof` would block the queue. In this change, repositories with a
merge queue do not require the check; their runs park at `merge` or they opt out. The intended
support is sketched under Future Work.

_Alternative:_ never enable auto-merge behind the gate. Simpler, but it parks every run of a
repository with required reviews, and protects only merges made by the factory; a person could
still merge an unproven commit.

## Risks / Trade-offs

- [The base phase fails for a reason other than the bug: the test imports a symbol the fix adds,
  setup fails, or it hangs] → Setup failures make the verdict `fail` with a setup finding, never
  `pass`. Support files are copied so a missing fixture is not the reason. A timeout or an
  output that says a test file could not load is inconclusive, so the agent is asked for a test
  that loads on the base and fails there by an assertion. The load-error detection reads the
  output (`Cannot find module`, `SyntaxError`, …): it is a heuristic across test runners; an
  unrecognised load error still counts as a failure, and the output tail is stored and shown.
- [Every repository must write its rules before its factory works again, the built-in flows
  included] → Admission stops with a visible blocker instead of wasting runs; the guide gives
  rule examples for common runners; the opt-out is one line. This is the price of a gate that
  cannot be removed by omission and a command that is never guessed.
- [The App needs `checks: write`] → A permission change every installation must accept. Until
  then no check is published there and auto-merge is not enabled behind the gate; direct merges
  still work, since `merge` trusts its stored proof. The GitHub App settings screen shows the
  missing permission.
- [A repository requires the check but the factory is paused or the server is down] → Pull
  requests from people have no check and cannot merge. The guide says to require the check only
  on repositories where every pull request comes from the factory, or to scope the rule; a
  proof for pull requests the factory did not open is future work.
- [Repositories with a merge queue] → Not supported behind the gate (decision 9); they park or
  opt out.
- [Proof time: two installs plus three test runs per attempt] → Only the changed test files run;
  `timeout_ms` bounds the whole proof.
- [Flaky tests] → The head runs twice, so a test that fails on one of them fails the proof as
  flaky; the finding goes to the implementer, who is asked to make the test deterministic. A
  retry of the base run is not added: a test that sometimes passes on the buggy code does not
  prove the fix.
- [A runner restart loses the job] → The poll gets 404 and the server starts it once more; a
  second loss is a `fail` with a runner finding.
- [Disk use from temporary worktrees] → Removed in `finally`, swept on runner start.
- [Two changes modify the `merge` requirement] → Whichever archives second merges both
  preconditions (review `pass` and proof) into one requirement text; tasks note it.

## Migration Plan

1. Ship the runtime routes and core helpers (no flow uses them yet).
2. Ship the `regression_proof` action, its storage and the "no change" outcome.
3. Add the step and the stricter prompt to the built-in flows.
4. Add `checks: write` to the App manifest and publish the check; ask existing installations to
   accept the permission.
5. Turn on the `merge` gate (default-on, pinned merge, auto-merge only where GitHub holds the
   gate), with the guide entry and
   the validation warning. Before this step, list the enabled factories whose repository has
   its own flow copy or relies on auto-merge, and tell their enablers.

Rollback: set `require_regression_proof: false` in the built-in flows' `merge` step, which
restores today's merge (auto-merge included); the step itself can stay.

## Future Work: merge queue (a separate change)

Not built here: no repository with an enabled factory uses a merge queue, and the design needs
a real queue to be verified against. The intended shape, so it is not lost:

1. **Enqueue the proved commit.** `merge` adds the pull request to the queue with GitHub's
   `enqueuePullRequest` and its expected head commit, so a head that moved after the proof is
   refused by GitHub.
2. **Follow the entry.** The run waits as an auto-merge run does. On each pass the watcher reads
   the pull request's queue entry and its merge commit. No webhook is needed.
3. **Publish the check on the merge commit.** The server creates `funny/regression-proof` there
   so the queue can advance. The default is to **carry the proof over**: verify the entry is for
   the proved head commit and publish a passing check that names the original proof. The proof
   is a claim about the pull request's change, which is the same; that the tests still pass on
   the new base is what the queue's CI checks. Running the proof again on the merge commit is a
   flow option, not the default (minutes per entry, inside the queue's time limit).
4. **Close the run.** Merged by GitHub: `merged`. Removed from the queue (conflict, red CI): the
   run parks in `waiting_human` with the reason.

To verify before designing it in detail: the App permission needed to enqueue (possibly a
merge-queue permission besides `pull_requests: write`, which every installation would have to
accept); the exact queue-entry query and its behaviour when the queue groups several pull
requests; and that the watcher's interval fits well inside the queue's check timeout.

## Open Questions

- Which labels exempt an issue from a regression test: `docs` and `chore` in the built-ins
  (every other issue, labelled or not, needs one); revisit once triage (from
  `factory-agent-roles`) classifies issues.
