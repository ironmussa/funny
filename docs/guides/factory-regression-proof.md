# The factory's regression proof

The server-run issue factory (the factory in a project's settings) does not merge a pull request
on green CI alone. Before it merges, it proves that the pull request's tests catch the bug it
fixes: the changed test files must **pass on the pull request's head** and **fail on the commit
the pull request branched from**. A test that passes on both proves nothing, and the factory does
not merge on it.

This guide is for the server factory. The standalone orchestrator (`packages/orchestrator`,
[its guide](./issue-factory.md)) has no regression proof.

Design and rules: `openspec/changes/factory-quality-gates` (`design.md`, and
`specs/issue-factory/spec.md`). Architecture: [openwiki/architecture/issue-factory.md](../../openwiki/architecture/issue-factory.md).

## What changes for a repository

The gate is **on by default**. A flow whose `merge` step needs the proof must say how to run the
repository's tests, and the built-in flows (`issue-to-merge`, `issue-to-pr`) cannot know that:
they ship with a `regression_proof` step **without rules**. So, until the repository has rules:

- the factory **admits no issue** into such a flow. Issues stay in the queue, and the factory
  shows the blocker _"Regression proof not configured: the flow "issue-to-merge" has no
  regression_proof rules, so it would never merge…"_;
- runs that were already in flight go on, but their `merge` step does not merge (_"Regression
  proof not configured"_) and the run waits for you.

A flow without a `merge` step (for example `issue-to-pr`, which stops at the pull request) is
never held back.

## Configure the rules

Copy the built-in flow to the repository's **default branch** as
`.funny/workflows/issue-to-merge.yaml` (start from
`packages/workflows/defaults/issue-to-merge.yaml`) and give its `regression_proof` step rules. The
factory reads flows from the default branch only, never from a run's branch, so a pull request
cannot change the rules that judge it. The copy replaces the built-in of that name, so keep it in
step with the built-in when that changes.

funny's own copy is [`.funny/workflows/issue-to-merge.yaml`](../../.funny/workflows/issue-to-merge.yaml).
Its step:

```yaml
- id: regression-proof
  depends_on: [pull-request]
  regression_proof:
    rules:
      - globs: ['packages/client/**/*.test.ts', 'packages/client/**/*.test.tsx']
        cwd: packages/client
        command: 'bun test --parallel {{files}}'
      - globs: ['packages/server/**/*.test.ts']
        cwd: packages/server
        command: 'bun test --isolate --timeout 20000 {{files}}'
      # … one rule per package with its own test flags …
      - globs: ['packages/**/*.test.ts', 'packages/**/*.test.tsx']
        command: 'bun test {{files}}'
    require_test: always
    exempt_labels: [docs, chore]
    timeout_ms: 600000
```

| Field             | Meaning                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rules`           | Each changed file goes to the **first** rule whose `globs` match it. `**/` also matches no directory, so `**/*.test.ts` matches a file at the root.                                              |
| `rules[].command` | Run with `sh -c`. Every `{{files}}` becomes the rule's files, each single-quoted, relative to `cwd`. Required in every command.                                                                  |
| `rules[].cwd`     | Directory to run in, relative to the repository root (no `..`). Use it for a package with its own test configuration (`bunfig.toml`, `jest.config.*`).                                           |
| `support_globs`   | Changed non-test files copied to the base with the tests (fixtures, snapshots, mocks, test helpers). Default: `__fixtures__`, `fixtures`, `__snapshots__`, `__mocks__`, `test-utils`, `testing`. |
| `setup_command`   | Run in each checkout before the tests, e.g. `bun install --frozen-lockfile`. Default: the head's `.funny.json` `postCreate` commands, what a thread worktree runs.                               |
| `require_test`    | `always` (default): an issue needs a changed test. `labels`: only issues with one of `labels`. `never`: a pull request without a test passes as `skipped`.                                       |
| `exempt_labels`   | Issues with one of these labels need no test, whatever `require_test` says. The built-ins use `[docs, chore]`.                                                                                   |
| `timeout_ms`      | Budget of the **whole** proof (setup and every test run of both checkouts). Default 10 minutes.                                                                                                  |

Only the changed test files run, never the whole suite: the proof answers "does this test catch
this bug", CI answers "is everything else still fine".

## How the proof decides

The proof runs on the enabler's runner, outside the agent's thread, in two fresh temporary
checkouts prepared the same way (so a difference between them is the code's, not the checkout's):

1. **Head first, twice.** The pull request's head commit; every command must pass on both runs.
   A test that passes once and then fails is **flaky** and proves nothing.
2. **Base.** The commit the pull request branched from (`git merge-base origin/<default> <head>`),
   with the changed test files and support files copied in from the head. At least one command
   must **fail by an assertion**. A run that times out, or whose test file cannot load there (a
   missing module, a syntax error), is **inconclusive**: write the test so it loads on the base
   and fails there by an assertion (for example, test the behaviour through code that already
   exists instead of importing a file the fix adds).

A pass keeps the base's failing output as its evidence; it is stored on the run
(`factory_runs.regression_proof`) with the commands, the files and both commits.

| Result                                                                                                                                  | What happens                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pass`                                                                                                                                  | The run goes on to CI and the merge.                                                                                             |
| `skipped` (no changed test, none required)                                                                                              | The run goes on.                                                                                                                 |
| `Regression proof failed: …` (no test where one is required, tests fail on the head, flaky, pass on the base, inconclusive on the base) | The implementing agent gets the finding on its thread and fixes the test, up to the step's attempts; then the run waits for you. |
| `Regression proof unavailable: …` (runner offline, setup failed, git, time)                                                             | No agent retry (the agent cannot fix it); the run waits for you.                                                                 |

Reading a test's output to tell "cannot load" from an assertion is a heuristic (`Cannot find
module`, `SyntaxError`, …). A load error it does not recognise still counts as a failure, so read
the stored output when a proof looks too easy.

## The merge

Unless the merge step opts out, `merge` reads the pull request's head and merges only a head with
a passing proof of **that exact commit**: the one the `regression-proof` step proved, or a new
proof it runs itself (for example when a CI fix pushed a new commit). The merge is a direct merge
pinned to that commit, so GitHub refuses it if someone pushes in between; it never turns on
auto-merge behind the gate.

To opt out, one line on the merge step (the server logs a warning each time a run loads such a
flow):

```yaml
- id: merge
  depends_on: [ci]
  merge:
    require_regression_proof: false
```

Not yet available (task 4.4 of the change): publishing the proof as a `funny/regression-proof`
check run, and auto-merge behind a branch rule that requires that check. Until then a repository
whose rules require reviews or other checks before a merge gets its runs parked at `merge`. When
the check run ships, require it only where every pull request comes from the factory, and not on
repositories that use a merge queue: a pull request from a person would have no check and could
not merge.

## "No change"

Sometimes the right answer to an issue is no code change (already fixed, cannot reproduce,
working as intended). When the agent opens no pull request and its branch has no commits ahead
of the default branch, the run does not fail: the factory comments the agent's last message on
the issue (after the line _"The issue factory made no change for this issue. The agent said:"_),
removes the run's worktree, and the run waits for you with the reason `no change`. It still
holds its issue, so it is not admitted again; close the issue, or retry the run.

With commits on the branch but no pull request, the run fails as before (_"No open pull request
from the branch …"_).
