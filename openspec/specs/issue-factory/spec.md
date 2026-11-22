# issue-factory Specification

## Purpose

The in-server issue factory watches a project's repository for labelled issues and runs a
configured workflow for each — implementing the change, opening a pull request, waiting on
CI, and merging — where the workflow, not a fixed setting, decides how far a run goes.

## Requirements

### Requirement: Admitted issues run the configured flow

When the factory admits an issue, the system SHALL execute the run's flow through the
workflow engine, as the enabling user on their runtime, rather than running a single fixed
implement step. A run's flow SHALL be the flow chosen when the issue was sent to the
factory, or, for an issue admitted by its label in automatic mode, the factory's configured flow
(by name, default `issue-to-merge`) at admission time. The run SHALL record its flow name,
and resuming, retrying or taking over a run SHALL use the run's recorded flow, not the
factory's current setting. A run SHALL record the flow's progress (current step and the
thread ids it spawned) so it can be observed and resumed-from-terminal.

#### Scenario: An admitted issue starts its flow

- **WHEN** the factory admits an issue with no active run and under the concurrency cap
- **THEN** the system starts the run's flow for that issue and records a run whose state reflects the flow's first step

#### Scenario: A missing or unparseable flow fails the run with a clear reason

- **WHEN** the run's flow name cannot be found or compiled
- **THEN** the run is marked failed with a message naming the flow, and no thread is started

#### Scenario: A sent issue runs the flow it was sent with

- **WHEN** a user sends an issue with the flow `issue-to-pr` to a factory configured with `issue-to-merge`
- **THEN** the run executes `issue-to-pr`

#### Scenario: Changing the factory's flow does not change a run in progress

- **WHEN** a run is in progress and the factory's configured flow is changed, and the run is then resumed after a restart or retried
- **THEN** the run continues with the flow it recorded

### Requirement: The flow is loaded from the repository's default branch

The system SHALL load the flow definition from the repository's default branch, never from
the pull request's branch. A workflow file added or edited on the issue's working branch
SHALL NOT change how that run executes.

#### Scenario: A PR-branch flow edit is ignored

- **WHEN** a run's working branch contains an edited or added workflow file for the configured flow
- **THEN** the run executes the flow as defined on the default branch, ignoring the branch's version

### Requirement: `wait_ci` resolves a pull request's checks to a terminal verdict

A `wait_ci` workflow step SHALL poll the status of the run's pull request checks until they
reach a terminal verdict — all required checks passed (green), at least one required check
failed (red), or a timeout — and surface that verdict to the flow. A green verdict SHALL
allow the flow to advance; a red verdict SHALL be reported as a step failure carrying the
failing checks so the flow's retry can act on it.

#### Scenario: Green checks advance the flow

- **WHEN** a `wait_ci` step polls a PR whose required checks all pass
- **THEN** the step succeeds and the flow advances to its next node

#### Scenario: Red checks fail the step with the failing checks

- **WHEN** a `wait_ci` step polls a PR with a failing required check
- **THEN** the step fails and the failure carries the failing check names for the flow's retry

#### Scenario: A timeout is a terminal, non-green verdict

- **WHEN** required checks do not reach a terminal state within the step's timeout
- **THEN** the step fails with a timeout reason rather than blocking the run indefinitely

### Requirement: The CI-driven fix loop

When `wait_ci` reports red, the flow SHALL be able to run a fix step (an agent resuming the
run's session) and re-check, up to the flow's configured retry limit, via the flow's
`retry.before_retry`. When the retry limit is exhausted without green, the run SHALL reach a
non-merged terminal or waiting state rather than merging.

#### Scenario: A red check triggers a fix and re-check

- **WHEN** `wait_ci` reports red and the retry limit is not exhausted
- **THEN** the flow runs its fix step with the failing-check context and re-runs `wait_ci`

#### Scenario: Exhausted retries do not merge

- **WHEN** the fix loop reaches its retry limit without green checks
- **THEN** the run stops before `merge` in a non-merged state that surfaces the failure

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

### Requirement: GitHub access uses the repository-scoped App token capped by the enabler

Every GitHub read and write a run performs (listing checks, enabling auto-merge, merging,
deleting a branch) SHALL use a repository-scoped GitHub App installation token capped by the
enabling user's own access to that repository. A run SHALL NOT use another user's
credentials, and SHALL surface a clear, actionable error when no capable token can be minted
(App not connected, not installed, or no owner access).

#### Scenario: Missing GitHub App access surfaces an actionable error

- **WHEN** a run needs GitHub access but no capable token can be minted
- **THEN** the run reports an error that names the cause and what to do, and does not act on the repository

### Requirement: A user sends chosen issues to their factory

The system SHALL let a user send one or more open issues of a project's repository to
their own factory for that project, choosing one flow for the whole send. Sending SHALL
require the `steer` capability on the project and SHALL act only on the caller's own
factory. The repository SHALL be the project's, never one named in the request. The system
SHALL refuse, per issue and with a reason, an issue that is closed, is a pull request, does
not exist, or already has a run that is waiting, in progress or parked for a person in that
factory; the other issues of the same send SHALL still be accepted. The flow SHALL be a
built-in factory flow or one defined in the repository's default branch, and SHALL NOT be a
workspace-only flow. A sent issue SHALL be processed once: when its run ends, the factory
SHALL NOT admit it again on its own.

#### Scenario: Sending issues queues them

- **WHEN** a user with `steer` sends issues #12 and #15 with the flow `issue-to-pr` to their enabled factory
- **THEN** both issues are queued in that factory with the flow `issue-to-pr`, and each shows as waiting in the Issues tab

#### Scenario: A user without steer cannot send

- **WHEN** a user with only view access to the project sends an issue to the factory
- **THEN** the send is refused and nothing is queued

#### Scenario: Closed issues and pull requests are refused

- **WHEN** a send includes a closed issue and a pull request number along with an open issue
- **THEN** the open issue is queued and the other two are refused, each with its reason

#### Scenario: An issue already in the factory is refused

- **WHEN** a send includes an issue that already has a waiting, running or parked run in the caller's factory
- **THEN** that issue is refused as already in the factory and no second run is created

#### Scenario: A workspace-only or unknown flow is refused

- **WHEN** a send names the flow `factory-issue` or a flow that is neither built in nor in the repository's default branch
- **THEN** the send is refused with a reason naming the flow, and nothing is queued

#### Scenario: A finished sent issue is not admitted again

- **WHEN** the run of a sent issue ends merged, failed or stopped
- **THEN** the factory does not start another run for that issue unless the user sends it again or retries the run

### Requirement: Sending is refused when the factory cannot work

The system SHALL refuse a send, queue nothing, and answer with the reason when the
caller's factory for the project is not configured, is paused, or cannot make progress at
the moment of the send: the enabler's runner is unreachable or cannot read the project's
repository, the enabler's runtime is sandbox and sandbox threads cannot be launched, or no
capable GitHub token can be minted for the repository. The check SHALL be made by the
server when the send arrives, not taken from a status shown earlier. The Issues tab SHALL
disable the send button and show the same reason while it applies.

#### Scenario: Sending to a paused factory is refused

- **WHEN** a user sends an issue while their factory for the project is paused
- **THEN** the send is refused with a message saying the factory is paused, and nothing is queued

#### Scenario: Sending while the runner is offline is refused

- **WHEN** a user sends an issue while the runner that would run their factory is offline
- **THEN** the send is refused with a message saying why the factory cannot work, and nothing is queued

#### Scenario: Queued issues wait when the factory becomes unable to work

- **WHEN** issues are waiting in the queue and the enabler's runner goes offline
- **THEN** the issues stay queued, the factory shows why it cannot work, and they are admitted once it can

### Requirement: The factory queue admits issues in the order they were sent

A sent issue SHALL wait in the factory's queue without holding a concurrency slot. While
the factory is enabled and can work, the system SHALL admit waiting issues as slots free
up, in the order they were sent; issues sent together SHALL be ordered oldest issue first.
Queued issues SHALL be admitted before issues found by the label in automatic mode. An issue that
cannot be admitted yet because of a dependency SHALL NOT delay the waiting issues behind
it.

#### Scenario: Queued issues wait for free slots

- **WHEN** a factory with a concurrency cap of 2 has two runs working and three issues waiting
- **THEN** no waiting issue starts until a working run stops holding its slot, and then the first-sent waiting issue starts

#### Scenario: Issues sent together start oldest first

- **WHEN** a user sends issues #30 and #8 together and both could start
- **THEN** #8 is admitted before #30

#### Scenario: Earlier sends go first

- **WHEN** a user sends #8, then later sends #3
- **THEN** #8 is admitted before #3

#### Scenario: The queue goes before the label

- **WHEN** a factory in automatic mode has one free slot, one waiting sent issue, and one labelled issue
- **THEN** the sent issue is admitted and the labelled issue waits

### Requirement: Pausing keeps the queue; clearing and stopping are explicit

Turning a factory off SHALL pause it: it SHALL admit nothing from its queue or its label,
SHALL keep the issues waiting in its queue, and SHALL let runs in progress continue to
their end. Turning it back on SHALL resume admitting the waiting issues in their order.
The system SHALL let the factory's enabler cancel one waiting issue, clear every waiting
issue ("Clear queue"), or clear the queue and stop every run in progress ("Stop all").
Clearing SHALL NOT stop runs in progress. A cancelled or cleared issue SHALL end in the
stopped state. "Stop all" SHALL require a confirmation in the UI.

#### Scenario: Pausing keeps the waiting issues

- **WHEN** a user pauses a factory that has three issues waiting and one run working
- **THEN** the three issues stay waiting, none is admitted, and the working run continues

#### Scenario: Resuming admits the waiting issues in order

- **WHEN** the user turns the paused factory back on
- **THEN** the waiting issues are admitted in the order they were sent as slots allow

#### Scenario: Clear queue keeps running work

- **WHEN** the user clears the queue of a factory with two waiting issues and one working run
- **THEN** the two waiting issues end stopped and the working run continues

#### Scenario: Stop all clears and stops

- **WHEN** the user confirms "Stop all" on a factory with waiting issues and working runs
- **THEN** the waiting issues end stopped, and every working run and its threads are stopped

#### Scenario: Cancelling one waiting issue

- **WHEN** the user cancels one waiting issue
- **THEN** that issue ends stopped and the other waiting issues keep their order

### Requirement: The factory runs in manual or automatic mode

A factory SHALL have a mode, `manual` or `automatic`, separate from whether it is running
or paused. In manual mode the factory SHALL admit only issues sent to it. In automatic
mode it SHALL also admit open issues carrying its label, after the issues sent to it.
Sending issues SHALL be allowed in both modes. The label SHALL be configurable only for,
and used only by, automatic mode; switching to manual mode SHALL keep the label so that
switching back restores it. A newly configured factory SHALL start in manual mode. A
factory that existed before this capability SHALL be in automatic mode with its label.
Pausing SHALL NOT change the mode. The system SHALL NOT add or remove labels on GitHub
issues to send them to the factory.

#### Scenario: Manual mode ignores labelled issues

- **WHEN** a running factory in manual mode has a repository with open issues carrying the factory's label
- **THEN** none of them is admitted unless it is sent to the factory

#### Scenario: Automatic mode admits labelled issues

- **WHEN** a running factory in automatic mode has free slots after its queue
- **THEN** it admits open labelled issues, oldest first, as before

#### Scenario: Sending works in automatic mode

- **WHEN** a user sends an issue without the label to a running factory in automatic mode
- **THEN** the issue is queued and admitted before labelled issues

#### Scenario: A new factory starts in manual mode

- **WHEN** a user configures a factory for a project for the first time
- **THEN** its mode is manual

#### Scenario: Switching modes keeps the label

- **WHEN** a user switches a factory with label `agent` from automatic to manual and back
- **THEN** the factory is in automatic mode with label `agent`

#### Scenario: Pausing keeps the mode

- **WHEN** a user pauses and later resumes a factory in automatic mode
- **THEN** after resuming it is still in automatic mode

#### Scenario: An existing factory moves to automatic mode

- **WHEN** a factory configured before this change was enabled with a label
- **THEN** after the upgrade it is in automatic mode and still admits issues carrying that label

### Requirement: Blocked issues wait for their blockers

Before admitting an issue, from its queue or by its label, the factory SHALL read the
issue's blockers from GitHub's native "blocked by" relation and SHALL NOT admit it while
any blocker is unfinished. A blocker SHALL count as finished when its issue is closed or
when it has a run in the same factory that ended merged. A blocker whose state cannot be
read SHALL count as unfinished. A waiting issue SHALL show why it waits: a blocker that is
not in the factory (with a way to send it), a blocker whose pull request waits for a
merge, a blocker whose run failed or was stopped, a blocker in another repository, or a
circular dependency. A blocker in another repository SHALL count as finished only when
its issue is closed. When a user
sends an issue whose open blocker is not in the factory and not part of the same send, the
Issues tab SHALL warn about it and SHALL still allow the send.

#### Scenario: A blocked issue waits until its blocker is merged

- **WHEN** issues #1 and #2 are sent together, #2 is blocked by #1, and there are two free slots
- **THEN** only #1 is admitted; #2 shows that it waits for #1, and is admitted once #1's run is merged or #1 is closed

#### Scenario: A blocked issue does not hold up the queue

- **WHEN** the first waiting issue is blocked and the second is not, and one slot is free
- **THEN** the second issue is admitted and the first keeps waiting

#### Scenario: A blocker not in the factory is named

- **WHEN** a waiting issue is blocked by an open issue that has no run in the factory
- **THEN** the waiting issue shows that its blocker is not in the factory and offers to send it

#### Scenario: A failed blocker is named

- **WHEN** a waiting issue's blocker has a run that failed or was stopped and the blocker is still open
- **THEN** the waiting issue keeps waiting and shows that its blocker failed or was stopped

#### Scenario: A circular dependency is named

- **WHEN** two waiting issues are each blocked by the other
- **THEN** neither is admitted and both show a circular dependency

#### Scenario: An unreadable blocker blocks

- **WHEN** the blockers of a waiting issue cannot be read from GitHub
- **THEN** the issue is not admitted on that pass

#### Scenario: A labelled blocked issue waits

- **WHEN** a factory in automatic mode finds a labelled issue blocked by an open issue
- **THEN** it is not admitted until the blocker is finished

#### Scenario: Sending without the blocker warns

- **WHEN** a user selects an issue whose open blocker is neither selected nor in the factory
- **THEN** the send bar warns about the blocker and the send is still allowed

### Requirement: The Issues tab shows each issue's factory state

The Issues tab SHALL show, for every issue that has a run in the caller's factory for the
project, the run's state (waiting with its position or the reason it waits, working,
pull request open, waiting for CI, fixing, waiting for a person, merged, failed, stopped)
and SHALL open the run's latest thread when the state is selected. An issue with a
waiting, running or parked run, a closed issue, or a pull request SHALL NOT be
selectable for sending.

#### Scenario: A running issue shows its state and cannot be selected

- **WHEN** an issue has a run waiting for CI in the caller's factory
- **THEN** its row shows that it waits for CI, has no selection checkbox, and opens the run's thread when its state is selected

#### Scenario: A waiting issue shows its position

- **WHEN** an issue is second among the factory's waiting issues
- **THEN** its row shows that it waits second in the queue, with a way to cancel it

### Requirement: Per-project factory toggle

The system SHALL let a project member turn a factory on or off for a project, storing the
settings per `(project, user)`: the watched issue label, the flow name, and the maximum
number of issues in flight at once. While off, the factory SHALL NOT admit new issues.
Turning it off SHALL NOT abort runs already in flight; they run to completion.

#### Scenario: Enable starts watching

- **WHEN** a member turns the factory on for a project with label `ready-for-agent`
- **THEN** the system begins admitting that repo's open issues carrying that label, up to the configured concurrency

#### Scenario: Disable stops admission only

- **WHEN** a member turns the factory off while two runs are in flight
- **THEN** no new issues are admitted, and the two in-flight runs continue to completion

### Requirement: Issue trigger admits labelled issues once

The system SHALL poll the watched repository's open issues through a repository-scoped
GitHub App token and start at most one flow run per issue. An issue already having a run
in a non-terminal state SHALL NOT be admitted again. Admission SHALL respect the
configured concurrency limit.

#### Scenario: One run per issue

- **WHEN** an issue already has a running flow and the poller sees it again
- **THEN** no second run is started for that issue

#### Scenario: Concurrency cap

- **WHEN** the concurrency limit is 2 and three labelled issues are open
- **THEN** at most two runs are in flight and the third waits

### Requirement: Flow runs as the enabler on their runtime

Each flow run SHALL execute as the user who enabled the factory, on that user's runtime
for the project — resolved from their `project_runtime_settings` row (local, worktree, or
sandbox with their connection), defaulting to local when absent. The system SHALL NOT run
a factory flow on another user's runner, and SHALL NOT fall back to a different runtime.

#### Scenario: Sandbox enabler

- **WHEN** the enabler's runtime for the project is sandbox and a run starts
- **THEN** the run's threads execute in that user's sandbox, using their connection, not another member's and not the project default_mode

#### Scenario: Enabler runner offline (local/worktree)

- **WHEN** the enabler's runtime is local or worktree and their runner is offline
- **THEN** the run does not start, and the factory reports the issue as waiting for the runner rather than routing elsewhere

### Requirement: Deterministic flow from the default branch

The flow SHALL be read from the repository's default branch, never from a pull request's
branch. A flow SHALL be a sequence of steps of two kinds: thread steps (an agent run with
a profile) and action steps (checks, commit, push, open PR, wait for CI, merge, request
approval). How far a run goes SHALL be decided by the flow's steps, not by a separate
setting.

#### Scenario: PR branch cannot change the flow

- **WHEN** a pull request branch adds a `merge` step to the flow file
- **THEN** the run ignores it and uses the flow from the default branch

### Requirement: A run is visible and controllable

The system SHALL record a run per issue with its current step and outcome, and link each
thread step to its thread. A member SHALL be able to pause the factory, stop a single run,
retry a failed step, and take over a run by sending a follow-up to its thread. The factory
SHALL surface when a run is waiting for the member.

#### Scenario: Take over a run

- **WHEN** a member sends a follow-up to a run's implementation thread
- **THEN** the run continues from that step with the member's input

#### Scenario: Waiting for the member

- **WHEN** a run's CI fails more times than the flow allows
- **THEN** the run is marked as waiting for the member and surfaced as such

### Requirement: The factory turns itself off on lost access

The system SHALL disable a factory when the user who enabled it loses access to the
project or deletes their account. Another member MAY re-enable it in their own name.

#### Scenario: Enabler loses access

- **WHEN** the enabling user is removed from the project
- **THEN** the factory is disabled and admits no further issues until re-enabled by another member

### Requirement: A regression proof shows a run's tests catch the bug

A flow SHALL be able to declare a `regression_proof` step, configured in the flow file with one
or more rules (the globs that identify test files, a test command containing a `{{files}}`
placeholder, and the directory the command runs in), the globs of test support files, and
whether a changed test is required (`always`, the default, for issues with a configured label,
or never), and labels whose issues need no test whatever that setting says (the built-in flows
require a test of every issue except those labelled `docs` or `chore`).
The step SHALL run on the run's runner, outside any agent thread, against the run's pull
request:

1. It SHALL collect the test files the pull request changes relative to its base (added or
   modified files matching a rule's globs), each assigned to the first rule that matches it.
2. It SHALL run each such rule's command on its files in a temporary checkout of the head
   commit, twice, and SHALL require every command to pass both times.
3. It SHALL then run the same commands on the same files in a temporary checkout of the pull
   request's base commit into which only those test files and the changed test support files
   were copied from the head commit, and SHALL require at least one command to fail by an
   assertion. A base run that times out, or whose test file cannot load (a missing module, a
   syntax error), SHALL NOT count as a failure of the test.

Both checkouts SHALL be prepared the same way before their tests: the step's setup command, or
else the head's project configuration setup (`postCreate`).

The verdict SHALL be `pass` only when both runs behave as required. It SHALL be `fail` with one
finding when a test is required and no test file changed, when the tests pass on the base
("the tests do not catch the bug"), when they fail on the head or pass there once and then fail
("the tests are flaky"), when they fail on the base only by a timeout or a load error
(inconclusive), when the checkout's setup fails, or when the proof cannot be run or read. A
`fail` SHALL say whether the implementing agent can fix it (its test) or not (the environment:
setup, git, time), and only the former SHALL be retried with the agent. When no test file changed and none is required, the
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

#### Scenario: A test that only times out or cannot load on the base proves nothing

- **WHEN** the changed test passes twice on the head, and on the base it times out, or fails
  because a module it imports does not exist there
- **THEN** the verdict is `fail` with an inconclusive finding, and the run does not merge on
  this proof

#### Scenario: A flaky test proves nothing

- **WHEN** the changed test passes on the head once and fails on the second run
- **THEN** the verdict is `fail` with the finding that the tests are flaky

#### Scenario: An unlabelled issue needs a test; a docs issue does not

- **WHEN** a run of a built-in flow is for an issue without labels and its pull request changes
  no test file
- **THEN** the verdict is `fail` with the finding that no regression test was added
- **WHEN** the issue is labelled `docs` or `chore` instead
- **THEN** the verdict is `skipped` and the run continues

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
