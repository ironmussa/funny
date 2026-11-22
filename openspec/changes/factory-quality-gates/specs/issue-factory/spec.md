# Spec Delta

## ADDED Requirements

### Requirement: A regression proof shows a run's tests catch the bug

A flow SHALL be able to declare a `regression_proof` step, configured in the flow file with one
or more rules (the globs that identify test files, a test command containing a `{{files}}`
placeholder, and the directory the command runs in), the globs of test support files, and
whether a changed test is required (`always`, for issues with a configured label, or never).
The step SHALL run on the run's runner, outside any agent thread, against the run's pull
request:

1. It SHALL collect the test files the pull request changes relative to its base (added or
   modified files matching a rule's globs), each assigned to the first rule that matches it.
2. It SHALL run each such rule's command on its files in a temporary checkout of the pull
   request's base commit into which only those test files and the changed test support files
   were copied from the head commit, and SHALL require at least one command to fail.
3. It SHALL run the same commands on the same files in a checkout of the head commit, and SHALL
   require every command to pass.

The verdict SHALL be `pass` only when both runs behave as required. It SHALL be `fail` with one
finding when a test is required and no test file changed, when the tests pass on the base
("the tests do not catch the bug"), when they fail on the head, when the checkout's setup fails,
or when the proof cannot be run or read. When no test file changed and none is required, the
verdict SHALL be `skipped`, recorded with that reason. Every temporary checkout SHALL be removed
whatever the outcome, and the proof SHALL have a time limit; a proof that exceeds it SHALL have
the verdict `fail` with a timeout finding.

#### Scenario: A test that fails without the fix and passes with it

- **WHEN** a pull request adds a test file matching a rule, the rule's command fails on the base
  with that file copied in, and passes on the head commit
- **THEN** the step's verdict is `pass` and the run continues to its next step

#### Scenario: A test that passes without the fix proves nothing

- **WHEN** the changed test files pass on the base commit with the files copied in
- **THEN** the verdict is `fail` with the finding that the tests do not catch the bug, and the
  run does not merge on this proof

#### Scenario: A changed fixture does not make the proof pass

- **WHEN** a pull request changes a test file and a fixture matching the support globs, and the
  test passes on the base once both are copied in
- **THEN** the verdict is `fail` with the finding that the tests do not catch the bug

#### Scenario: Packages with different test commands

- **WHEN** a pull request changes test files matched by two rules with different commands and
  directories
- **THEN** each rule's command runs in its directory on its own files, in both phases

#### Scenario: A required test is missing

- **WHEN** a test is required for the run's issue and the pull request changes no file matching
  a rule
- **THEN** the verdict is `fail` with the finding that no regression test was added

#### Scenario: No test is required and none changed

- **WHEN** no test is required for the issue and the pull request changes no test file
- **THEN** the verdict is `skipped` with that reason, and the run continues

#### Scenario: Temporary checkouts never stay behind

- **WHEN** a proof run ends by pass, fail, timeout, or an error of the runner
- **THEN** no temporary checkout or branch created for it remains on the runner

### Requirement: A regression proof outlives a request and a restart

The system SHALL run a regression proof as a job on the runner that the server starts and then
polls, so that the proof's duration is not bounded by the deadline of one server-to-runner
request. Starting a proof for a thread and head commit whose proof is already running or
finished on that runner SHALL return that proof rather than start another. When the runner no
longer knows the job, the server SHALL start it again once; a second loss SHALL make the verdict
`fail`.

#### Scenario: A proof longer than a request deadline

- **WHEN** a proof takes longer than the deadline of a server-to-runner request
- **THEN** the server still reads its verdict when it ends

#### Scenario: The server restarts during a proof

- **WHEN** the server restarts while a proof is running and the run's step is replayed
- **THEN** the step joins the running proof instead of starting a second one

#### Scenario: The runner restarts during a proof

- **WHEN** the runner restarts while a proof is running
- **THEN** the server starts the proof again once, and a second loss gives a `fail` verdict, never
  a `pass`

### Requirement: A factory admits issues only when its flow can prove them

The built-in flows SHALL declare the `regression_proof` step without rules, and a repository
SHALL supply the rules in its flow file on the default branch. Before admitting an issue, the
system SHALL check the flow it would run: when its `merge` step requires a regression proof and
its `regression_proof` step is missing or has no rule, the system SHALL NOT admit the issue,
SHALL leave it in the queue holding no slot, and SHALL record on the factory the blocker
"regression proof not configured". The factory's settings and queue SHALL show that blocker.
Runs already in flight SHALL NOT be stopped by it.

#### Scenario: A repository that has not configured the proof

- **WHEN** an issue is sent to a factory whose flow requires the proof and has no rules
- **THEN** no run starts, the issue stays queued, and the factory shows "regression proof not
  configured"

#### Scenario: The repository adds its rules

- **WHEN** rules are added to the flow file on the default branch
- **THEN** the next admission pass admits the queued issue and the blocker is gone

#### Scenario: An explicit opt-out admits

- **WHEN** the flow's `merge` step sets `require_regression_proof: false`
- **THEN** issues are admitted without proof rules

### Requirement: Regression proof findings return to the implementer

A failed regression proof SHALL be sent to the run's implementing thread as a follow-up that
names the finding, the files and commands, and the output tail, and the proof SHALL run again on
the new head commit, up to the step's configured attempts. When the attempts are exhausted
without a `pass` (or an allowed `skipped`), the run SHALL park in `waiting_human` with the last
proof on the run, and SHALL NOT merge.

#### Scenario: A finding becomes a fix and a new proof

- **WHEN** the proof fails and attempts remain
- **THEN** the implementer's thread receives a follow-up with the finding, and after it pushes, the
  proof runs again on the new head commit

#### Scenario: Exhausted attempts wait for a person

- **WHEN** the proof has failed on its last attempt
- **THEN** the run is in `waiting_human` with the proof's finding shown on the run, and its pull
  request is not merged

### Requirement: A regression proof holds for one commit

The system SHALL store each proof with the head commit it ran on, and SHALL treat a proof as
valid only for that commit. A commit pushed after the proof SHALL require a new proof before the
run can merge.

#### Scenario: A push after a passing proof

- **WHEN** a proof passed on commit A and the branch's head is now commit B
- **THEN** the run has no valid proof until the proof runs and passes on commit B

### Requirement: A regression proof is published as a check of the commit

The system SHALL publish each regression proof as a check run named `funny/regression-proof` on
the commit it ran on, created by the deployment's GitHub App: passing for a `pass` and for an
allowed `skipped`, failing otherwise, with the finding, files, commands and output tail in its
summary. Credentials handed to an agent or a sandbox SHALL NOT be able to create or change that
check. The system SHALL treat the check as held by GitHub only when it is required on the pull
request's base branch with the deployment's App as its source; a requirement without that source
SHALL count as not held. While a run waits on auto-merge, a commit pushed to its pull request
SHALL be proved and SHALL get its own check; a failing one SHALL leave the pull request
unmerged and the finding on the run.

#### Scenario: A passing proof shows on the pull request

- **WHEN** a proof passes on a commit
- **THEN** that commit has a passing `funny/regression-proof` check created by the deployment's App

#### Scenario: An agent cannot publish the check

- **WHEN** an agent or a sandbox uses the credentials it was given to create a
  `funny/regression-proof` check
- **THEN** GitHub refuses, or the check does not come from the deployment's App and does not
  satisfy the branch's requirement

#### Scenario: A required check without the App as source

- **WHEN** the base branch requires a check named `funny/regression-proof` from any source
- **THEN** the system does not treat the gate as held by GitHub and does not enable auto-merge

#### Scenario: A commit pushed while auto-merge waits

- **WHEN** a run waits on auto-merge and a new commit is pushed to its pull request
- **THEN** the proof runs on the new commit and its check is published, and GitHub merges only if
  that check passes

#### Scenario: The App cannot publish

- **WHEN** the App's installation lacks permission to create check runs
- **THEN** the proof is still stored on the run, no check is published, and auto-merge is not
  enabled behind the gate

### Requirement: A run that finds nothing to change ends without a pull request

When a flow's `create_pr` step finds no open pull request and the run's branch has no commits
ahead of the default branch on GitHub, the system SHALL treat the run as having made no change:
it SHALL post the implementing thread's final message on the issue, remove the run's worktree,
and park the run in `waiting_human` with the reason `no change`. When the branch has commits
ahead but no pull request, the step SHALL fail as before.

#### Scenario: The issue's claim does not hold

- **WHEN** the implementer ends without pushing a commit, saying the issue's claim does not hold
- **THEN** the issue receives a comment with that explanation, the run is in `waiting_human` with
  the reason `no change`, and no pull request exists

#### Scenario: Commits pushed but no pull request

- **WHEN** the run's branch has commits ahead of the default branch and no open pull request
- **THEN** the step fails saying the agent did not open a pull request

### Requirement: The built-in implement prompt asks for verified, complete fixes

The built-in flows' implement step SHALL instruct the agent to: find the root cause; cover every
case the issue names or state in the pull request why one is left out; consider concurrency and
edge cases; verify or measure first when the issue asks for it, reporting the result, and push
nothing and explain why when the issue's claim does not hold; run the full test suite of each
package it changes; and state in the pull request how the regression test was shown to fail
without the fix. The built-in `issue-to-merge` and `issue-to-pr` flows SHALL run a
`regression_proof` step after the pull request is opened and before waiting for its checks.

#### Scenario: The built-in flow proves its regression test

- **WHEN** a run of the built-in `issue-to-merge` flow opens its pull request
- **THEN** a `regression_proof` step runs before `wait_ci` and `merge`

## MODIFIED Requirements

### Requirement: `merge` integrates a green pull request

A `merge` workflow step SHALL merge the run's pull request only after its checks are green,
optionally deleting the working branch, and SHALL mark the run merged on success. A `merge` step
SHALL NOT merge a pull request whose required checks are not green.

Unless the step sets `require_regression_proof: false`, `merge` SHALL also require, checked when
the step starts, a regression proof with verdict `pass` (or `skipped` when no test is required)
for the pull request's current head commit, whether or not the flow declares a
`regression_proof` step. When the stored proof is for another commit or there is none, `merge`
SHALL run the proof on the current head commit with the flow's `regression_proof` configuration
before deciding; a flow with no such configuration SHALL get the verdict `fail` with the finding
that no regression proof is configured. Without an allowed verdict it SHALL NOT merge and the
run SHALL park in `waiting_human` with the reason. With the proof required, `merge` SHALL merge
exactly the commit that was proved. When GitHub will not merge the pull request directly,
`merge` SHALL enable GitHub's auto-merge only if the `funny/regression-proof` check is required
on the base branch from the deployment's GitHub App; otherwise it SHALL NOT enable auto-merge
and the run SHALL park with GitHub's reason and how to require the check.

With `require_regression_proof: false`, `merge` SHALL behave as before (directly, or by enabling
auto-merge when the repository requires it), and flow validation SHALL report the setting as a
warning.

#### Scenario: A green PR is merged and the run completes

- **WHEN** a `merge` step runs on a PR whose required checks are green and whose head commit has
  a passing proof
- **THEN** that commit is merged and the run is marked merged

#### Scenario: Merge is refused when checks are not green

- **WHEN** a `merge` step runs on a PR whose required checks are not green
- **THEN** the step does not merge and the run does not reach the merged state

#### Scenario: A CI fix after the proof

- **WHEN** the proof passed on commit A, a CI fix pushed commit B, and `merge` starts with green
  checks on B
- **THEN** `merge` runs the proof on B, and merges B only if it passes

#### Scenario: A stale proof that no longer passes

- **WHEN** `merge` runs the proof on the current head commit and its verdict is `fail`
- **THEN** the step does not merge and the run parks in `waiting_human` with the finding

#### Scenario: A flow without the step does not skip the gate

- **WHEN** a repository flow has a `merge` step, no `regression_proof` step, and does not set
  `require_regression_proof: false`
- **THEN** the run does not merge and parks in `waiting_human` saying no regression proof is
  configured

#### Scenario: An explicit opt-out

- **WHEN** a flow's `merge` step sets `require_regression_proof: false`
- **THEN** `merge` needs only green checks, and validating the flow reports a warning about the
  setting

#### Scenario: No auto-merge where GitHub does not hold the gate

- **WHEN** the proof is required, GitHub will not merge the pull request directly, and the
  `funny/regression-proof` check is not required on the base branch from the deployment's App
- **THEN** auto-merge is not enabled, and the run parks in `waiting_human` with GitHub's reason and
  how to require the check

#### Scenario: Auto-merge where GitHub holds the gate

- **WHEN** the proof is required, GitHub will not merge directly, and the check is required on the
  base branch from the deployment's App
- **THEN** auto-merge is enabled for the pull request and the run waits for GitHub to merge

#### Scenario: The head moves between the check and the merge

- **WHEN** a commit is pushed after `merge` verified the proof and before GitHub merges
- **THEN** the merge of the proved commit is refused by GitHub and the run parks, unmerged
