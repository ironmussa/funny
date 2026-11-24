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
`retry.before_retry`. The fix step SHALL run with its own resolved agent options (see "Agent
steps run with their own options"), on the implementing thread. When the retry limit is
exhausted without green, the run SHALL reach a non-merged terminal or waiting state rather than
merging.

#### Scenario: A red check triggers a fix and re-check

- **WHEN** `wait_ci` reports red and the retry limit is not exhausted
- **THEN** the flow runs its fix step with the failing-check context and re-runs `wait_ci`

#### Scenario: Exhausted retries do not merge

- **WHEN** the fix loop reaches its retry limit without green checks
- **THEN** the run stops before `merge` in a non-merged state that surfaces the failure

### Requirement: `merge` integrates a green pull request

A `merge` workflow step SHALL merge the run's pull request only when all of these hold, checked
when the step starts and whatever path of the flow led to it: the pull request's head commit has
a passing review (unless the step sets `require_review: false`), the change's risk class is
allowed by the factory's auto-merge setting (`low_risk` by default, or `all`), and the pull
request's checks are green on a commit that is up to date with the current base branch, reached
through the repository's merge lane. Only a verdict of the flow's own `review` step SHALL count
as that review: a check, status, comment or approval that an external reviewer (a review bot
such as CodeRabbit, or any other app) leaves on the pull request is a check like any other and
SHALL NOT stand in for it. It MAY delete the working branch, and SHALL mark the run merged on
success. A `merge` step SHALL NOT merge a pull request whose required checks are not green. A
run whose review is missing or not passing, or whose risk class is not allowed, SHALL park in
`waiting_human` with that reason.

Unless the step sets `require_regression_proof: false`, `merge` SHALL also require, checked when
the step starts, a regression proof with verdict `pass` (or `skipped` when no test is required)
for the commit it merges, whether or not the flow declares a `regression_proof` step. A commit
the merge lane made by merging only the base branch into a proved commit, whose checks then
passed, SHALL hold that commit's proof, as it holds its review: the proof's tests ran in the
implementer's checkout, which does not have that merge commit, and a commit made elsewhere is
not run there. When the stored proof is for another commit or there is none, `merge` SHALL run
the proof on that commit with the flow's `regression_proof` configuration before deciding; a flow with no such configuration SHALL get
the verdict `fail` with the finding that no regression proof is configured. Without an allowed
verdict it SHALL NOT merge and the run SHALL park in `waiting_human` with the reason. With the
proof required, `merge` SHALL merge exactly the commit that was proved. When GitHub will not
merge the pull request directly, `merge` SHALL enable GitHub's auto-merge only if the
`funny/regression-proof` check is required on the base branch from the deployment's GitHub App;
otherwise it SHALL NOT enable auto-merge and the run SHALL park with GitHub's reason and how to
require the check.

With `require_regression_proof: false`, `merge` SHALL need no proof, and flow validation SHALL
report the setting as a warning. With `require_review: false` as well, `merge` SHALL behave as
before both gates (directly, or by enabling auto-merge when the repository requires it); with
the review required, it SHALL merge exactly the reviewed commit.

#### Scenario: A green PR is merged and the run completes

- **WHEN** a `merge` step runs on a PR whose head commit passed review and has a passing proof,
  whose risk class is `low`, and whose checks are green on the current base
- **THEN** that commit is merged (or GitHub's merge queue merges it) and the run is marked merged

#### Scenario: Merge is refused when checks are not green

- **WHEN** a `merge` step runs on a PR whose required checks are not green
- **THEN** the step does not merge and the run does not reach the merged state

#### Scenario: A CI fix after the proof

- **WHEN** the proof passed on commit A, a CI fix pushed commit B, and `merge` starts with green
  checks on B
- **THEN** `merge` runs the proof on B, and merges B only if it passes

#### Scenario: The merge lane brings the base into a proved commit

- **WHEN** the proof passed on commit A, the merge lane merged the moved base branch into A as
  commit M, and the checks are green on M
- **THEN** `merge` merges M on A's proof, without running the proof again, and the
  `funny/regression-proof` check on M says the tests ran on A

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
- **THEN** `merge` needs no proof (the review and the risk class still apply), and validating
  the flow reports a warning about the setting

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

#### Scenario: A high-risk change waits for a person

- **WHEN** a `merge` step runs on a reviewed PR whose risk class is `high` and the factory
  allows only `low_risk`
- **THEN** the run parks in `waiting_human` with the reason "high risk" and the PR is not merged

#### Scenario: An external reviewer's check is not a review

- **WHEN** a `merge` step runs on a PR whose head commit has a successful check and an approval
  from an external review bot, all checks green, and no passing verdict from the flow's `review`
  step for that commit
- **THEN** the run parks in `waiting_human` with the reason "no review" and the PR is not
  merged

#### Scenario: An unreviewed PR in a flow without a review step

- **WHEN** a repository flow has no `review` step and its `merge` step does not set
  `require_review: false`
- **THEN** the run parks in `waiting_human` with the reason "no review" and the PR is not
  merged

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

### Requirement: Factory agents have separate roles and see only stored results

A factory run SHALL use agents in four roles: triage, implementer, reviewer and sentinel. Only
the implementer SHALL write to the run's branch. No agent SHALL merge a pull request, approve
it, or publish a status or comment on GitHub; the server SHALL do those. Triage, reviewer and
sentinel SHALL each run on a new thread in a read-only permission mode with write tools denied,
whatever the flow says. An agent SHALL receive another role's result only as the validated
result the server stored, and SHALL NOT be given another agent's thread.

#### Scenario: The reviewer cannot write

- **WHEN** a repository flow sets `permission_mode: autoEdit` on its `review` step
- **THEN** the flow is refused when it loads, naming the step and the field

#### Scenario: The reviewer does not see the implementer's thread

- **WHEN** the review step of a run starts
- **THEN** its prompt contains the run's contract (or, for a run without one, the issue's URL),
  the commit to review and the pull request, and no message from the implementer's thread

### Requirement: Role results are structured and validated

Triage, reviewer and sentinel SHALL end with a structured result that the server validates
against the role's schema. An invalid or missing result SHALL get one request to re-emit it on
the same thread. If it is still invalid, a triage SHALL let the run proceed without a contract
(and the run SHALL show that it has none), and a review or sentinel SHALL fail closed: the run
SHALL NOT be merged and SHALL park in `waiting_human`, and an incident SHALL escalate to a
person.

#### Scenario: A review answers in prose

- **WHEN** a review's final message has no valid result, twice
- **THEN** the run parks in `waiting_human` with the reason "review gave no verdict" and the
  pull request is not merged

#### Scenario: A triage answers in prose

- **WHEN** a triage's final message has no valid result, twice
- **THEN** the implementer starts without a contract and the run row shows "no contract"

### Requirement: Triage decides whether an issue can be worked unattended

A flow's `triage` step SHALL run before any implementer step and SHALL answer `ready` with a
contract (acceptance criteria, likely paths, risk hints), `needs_info` with questions, or
`too_big` with a proposed split. On `ready` the system SHALL store the contract on the run and
pass it to the implementer and the reviewer. On `needs_info` or `too_big` the system SHALL post
one comment on the issue from a fixed template, with at most five questions or parts of at most
300 characters each, with mentions and links removed, and SHALL park the run in `needs_info`,
holding no concurrency slot.

#### Scenario: An ambiguous issue

- **WHEN** triage answers `needs_info` with two questions
- **THEN** the issue gets one comment listing the two questions, the run is in `needs_info`,
  and the factory's free slots do not count it

#### Scenario: Triage text cannot mention people

- **WHEN** a triage question contains `@someone` and a link
- **THEN** the posted comment contains the question without the mention and without the link

#### Scenario: A clear issue

- **WHEN** triage answers `ready`
- **THEN** the implementer's first prompt includes the contract's acceptance criteria and the
  run row shows the contract

### Requirement: A `needs_info` run is triaged again when the issue changes

The system SHALL triage a `needs_info` run again when the issue is edited or commented after
the triage, on the factory's next tick with a free slot, and SHALL let a member retry it. A
`needs_info` run SHALL keep its issue from being admitted into a second run.

#### Scenario: The author answers

- **WHEN** the issue gets a new comment after a run went to `needs_info`
- **THEN** on a later tick with a free slot the run is triaged again

#### Scenario: The label does not start a second run

- **WHEN** an issue with a `needs_info` run still carries the factory's label
- **THEN** no second run is created for it

### Requirement: Runs with overlapping paths do not work at the same time

After triage, the system SHALL NOT start the implementer of a run whose contract's likely paths
overlap the likely paths of another run of the same factory that is changing files (working,
with its pull request open or waiting for its checks, fixing, reviewing or merging). Such a run SHALL release its slot and wait in the queue, keeping its
contract, with a reason naming the run it waits for. A run without a contract SHALL neither hold
paths nor wait for them.

#### Scenario: Two issues touch the same file

- **WHEN** run #12 is working with likely path `src/db/migrate.ts` and run #13's triage lists
  the same path
- **THEN** run #13 waits with the reason "paths overlap #12" and starts after #12 leaves those
  states, without being triaged again

### Requirement: Changes are checked for weakened tests and classified by risk

For each head commit of a run's pull request, the system SHALL report, without an agent: removed test files or test cases, added skip or focus markers, lowered coverage
thresholds, and edits to CI workflow files. The system SHALL classify the change `high` risk
when it has any such finding, exceeds the factory's line limit (400 unless the factory sets
another) in changed lines (not counting tests, Markdown files, lockfiles, translation
catalogs, stories, snapshots and the factory's own globs left out of size), touches a default or
factory-configured sensitive path, or the contract lists a risk hint, and `low` otherwise. No
agent result SHALL lower the risk class.

#### Scenario: The factory's own size settings

- **WHEN** a factory sets its line limit to 800 and leaves `**/generated/**` out of size, and a
  change adds 3000 lines under `src/generated/` and 500 elsewhere
- **THEN** the change is not high risk for its size, and a sensitive path under
  `src/generated/` would still make it high risk

#### Scenario: A skipped test

- **WHEN** a CI fix adds `.skip` to a test and the checks turn green
- **THEN** the run's risk class is `high`, the reviewer receives the finding, and the run row
  shows it

#### Scenario: A small change in ordinary code

- **WHEN** a 60-line change touches no sensitive path and weakens no test
- **THEN** its risk class is `low`

### Requirement: The review judges one commit against the contract

A flow's `review` step SHALL judge the pull request's head commit against the run's contract,
or against the issue when the run has no contract, answering `pass` or `fail` with findings that
each carry a severity. The verdict SHALL hold only for the commit it names. The system SHALL
start the review of a head commit when that commit's checks start, unless the step sets
`early: false` or the factory's review limit has no free slot, and SHALL stop a review and
discard its result when the head commit changes while it runs. A pull request SHALL NOT be
merged on a verdict alone: the checks of the same commit SHALL be green too. A `fail` with a
critical or high finding SHALL send the findings to the implementer as a follow-up, after which
the checks and the review SHALL run again on the new head commit, up to the review loop's limit
(three reviews by default); a `fail` with only lower findings SHALL count as a pass. When the
rounds run out the run SHALL park in `waiting_human`.

#### Scenario: The review runs while the checks run

- **WHEN** the checks of commit A start and the factory's review limit has a free slot
- **THEN** a review of commit A starts before the checks finish, and the run reaches `merge`
  only after both the checks and the review of A passed

#### Scenario: A CI fix replaces the commit under review

- **WHEN** commit A's checks fail while its review runs and the implementer pushes commit B
- **THEN** the review of A is stopped, its result is not stored, and B is reviewed

#### Scenario: A run without a contract

- **WHEN** the review step starts for a run that has no contract
- **THEN** the reviewer is given the issue's URL and judges the commit against the issue

#### Scenario: Findings are fixed and reviewed again

- **WHEN** the review of commit A fails with a high finding and the implementer pushes commit B
- **THEN** the checks run on B and a new review thread judges B

#### Scenario: A push after a pass

- **WHEN** a review passed commit A and a new commit B is pushed to the branch
- **THEN** the pass does not allow merging B

#### Scenario: Rounds run out

- **WHEN** the review fails with a critical finding on the last allowed round
- **THEN** the run parks in `waiting_human` and nothing is merged

### Requirement: Review verdicts are published on the pull request

The system SHALL post each review verdict on the pull request as a review comment that never
approves, listing the findings, and, when the GitHub App installation grants permission to
write commit statuses, SHALL set a `funny/review` status on the reviewed commit to success for a
pass and failure for a fail. Without that permission the factory settings SHALL say that the
installation must accept the new permission to publish the status.

#### Scenario: A pass is visible on GitHub

- **WHEN** a review passes commit A on an installation with status write permission
- **THEN** the pull request has a review comment with the verdict and commit A has a successful
  `funny/review` status

#### Scenario: An installation without the new permission

- **WHEN** the installation has not accepted status write permission
- **THEN** the verdict is posted as a review comment only and the settings show the notice

### Requirement: The settings warn when the reviewer is the implementer's model

The factory settings SHALL show a notice when the flow's `review` step resolves to the same
provider and model as its implementer step. The notice SHALL NOT prevent saving or running.

#### Scenario: Same model for both roles

- **WHEN** a factory's implementer and `review` steps both resolve to the same provider and model
- **THEN** the factory settings show the notice and the factory still runs

### Requirement: Merges go through one lane per repository on the current base

The system SHALL merge factory pull requests of a repository and base branch one batch at a
time, across every factory on that repository; a batch holds one pull request unless the
factory's merge queue groups several (`factory-integration`). When the base branch requires
GitHub's merge queue, the system SHALL add the pull request to it and follow it; otherwise it
SHALL merge a pull request only after its changes passed the checks on a commit that includes the
current base branch, brought in with a merge (never a rebase), and only if the base branch has
not moved since; if it moved, it SHALL bring the base in and check again. Pull requests SHALL enter the lane in the order their runs were admitted, except that a
run whose issue is blocked by another run's issue SHALL follow that run. Each merge SHALL use
its own run's GitHub access. The system SHALL decide and perform every merge itself and SHALL
NOT start an agent to decide one: a merge that fails for a reason no code change can fix (a
missing App permission, a branch rule, a GitHub error that outlasts its retries) SHALL park the
run in `waiting_human` with that reason.

#### Scenario: Two runs green on an old base

- **WHEN** runs #12 and #13 have green checks on the same old base and #12 merges first
- **THEN** #13 is brought up to date with the new base and merged only after its checks are
  green on it

#### Scenario: A branch rule refuses the merge

- **WHEN** GitHub refuses a run's merge because a branch rule requires a human approval
- **THEN** the run parks in `waiting_human` with that reason and no agent is started

#### Scenario: Removed from GitHub's merge queue

- **WHEN** GitHub's merge queue removes a run's pull request because its checks failed
- **THEN** the failure is sent to the implementer as a CI fix and the run re-enters the lane
  after its checks and review pass

### Requirement: Stage limits are declared by the flow and tuned per factory

Each agent node of a factory flow MAY be limited to a number of runs inside it at once, counted
per factory. The flow SHALL set the default limit, and a member with `steer` SHALL be able to
replace it per node in the factory settings. The limit of `merge` (one per repository and base
branch) SHALL NOT be changeable, whatever the flow or the settings say. The factory's maximum
of runs in flight SHALL keep bounding how many runs it admits, and a run waiting for the merge
slot SHALL count as in flight.

#### Scenario: A full merge lane slows admissions

- **WHEN** a factory with a maximum of two runs has both waiting for the merge slot
- **THEN** it admits no issue until one of them merges or parks

#### Scenario: Fewer reviewers than implementers

- **WHEN** a factory sets the `review` limit to 1 and two runs reach `review`
- **THEN** one is reviewed while the other waits for the slot, and implementers of other runs
  keep working

#### Scenario: The merge limit cannot be raised

- **WHEN** a member saves a limit of 2 for `merge`
- **THEN** the save is refused and merges stay one at a time per repository

#### Scenario: A repository flow without a merge limit

- **WHEN** a repository flow's `merge` node declares no concurrency
- **THEN** its runs still merge one at a time per repository

### Requirement: Integration conflicts go back to the implementer

When the pull request cannot be brought up to date with the base branch because of a conflict,
the system SHALL send the conflict to the implementer with the diff of the pull request that
merged in between, and, for a conflicting lockfile or numbered migration, a specific
instruction. The implementer SHALL bring the base branch in with a merge. If the branch's
history no longer contains the last reviewed commit, the system SHALL park the run in
`waiting_human` and SHALL NOT merge it.

#### Scenario: Conflict after another merge

- **WHEN** #12 merged and #13's update conflicts in `src/app.ts`
- **THEN** #13's implementer gets a follow-up with the conflict and #12's diff, and #13 goes
  through checks and review again

#### Scenario: Force push

- **WHEN** the implementer rewrites the branch so it no longer contains the reviewed commit
- **THEN** the run parks in `waiting_human` with the reason "branch history rewritten"

### Requirement: A red base branch after a factory merge opens an incident

When a repository's base branch turns red within 24 hours of a factory merge, the system SHALL
open one incident for that repository and base branch, pause admissions of every factory on the
repository with a reason naming the incident, and run a sentinel over the factory merges since
the last green base commit. When the sentinel names a culprit merge, the system SHALL open a
revert pull request for it and notify that run's enabler; otherwise it SHALL notify every
affected enabler. Revert pull requests SHALL NOT be merged automatically. The incident SHALL
close, and admissions resume, when the base branch is green again or a member closes it.

#### Scenario: A merge breaks the base branch

- **WHEN** the base branch turns red an hour after #12 merged and the sentinel names #12
- **THEN** a revert pull request for #12 is opened, #12's enabler is notified, and no factory on
  the repository admits issues until the base branch is green

#### Scenario: Red long after any factory merge

- **WHEN** the base branch turns red three days after the last factory merge
- **THEN** no incident is opened

### Requirement: Agent steps run with their own options

Each agent step of a factory flow, including a `retry.before_retry` fix step, SHALL run with
the provider, model, effort, permission mode, allowed tools and denied tools resolved for that
step, in this order of precedence: the factory's step override (provider, model, effort only),
the step's own fields, the flow's `defaults:`, then the factory's existing defaults. The options
SHALL apply to that step only: a later step that sets none of them SHALL run with the resolved
options of its own (from `defaults:` or the factory defaults), not with those of the step before
it. A step that continues the implementing thread SHALL carry its options on the follow-up
message; the first step SHALL carry them on the new thread.

#### Scenario: A fix step runs on a different model than the implementation

- **WHEN** a flow's implement step sets `model: opus` and its `before_retry` sets `model: sonnet`, and CI fails
- **THEN** the fix runs on the implementing thread with `sonnet`, and the implementation ran with `opus`

#### Scenario: Options do not leak to the next step

- **WHEN** a flow sets `defaults: { model: sonnet }`, a middle agent step sets `model: opus`, and a later agent step sets no model
- **THEN** the later step runs with `sonnet`

#### Scenario: Tool restrictions are applied

- **WHEN** an agent step sets `denied_tools: [WebFetch]`
- **THEN** that step's agent runs without `WebFetch`

### Requirement: A factory flow that uses an option the factory cannot apply is refused

When a factory flow is loaded, the system SHALL refuse it, with a message naming the step and
the field, if any agent step uses a field or value the factory does not apply. Permission
modes that wait for a person (`ask`, `confirmEdit`) and `auto` SHALL be refused; `autoEdit`
and `plan` SHALL be accepted. A step whose resolved provider does not apply tool lists SHALL
be refused when it sets `allowed_tools` or `denied_tools`, so a restriction is never silently
dropped. A refused flow SHALL fail the run before any thread starts, as a
missing flow does. A flow that the factory used to accept and that sets only fields the factory
applies SHALL keep loading.

#### Scenario: An unsupported permission mode is refused

- **WHEN** a repository's `issue-to-merge.yaml` sets `permission_mode: ask` on its implement step
- **THEN** the run fails before starting a thread with a message naming the step `implement` and the field `permission_mode`

#### Scenario: An unknown agent field is refused

- **WHEN** an agent step sets `output_format`
- **THEN** the flow is refused with a message naming the step and `output_format`

#### Scenario: A tool list on a provider that cannot apply it is refused

- **WHEN** an agent step sets `provider: codex` and `denied_tools: [Bash]`
- **THEN** the flow is refused with a message naming the step, `denied_tools` and the provider

#### Scenario: Today's built-in flows still load

- **WHEN** the factory loads the built-in `issue-to-merge` or `issue-to-pr`
- **THEN** the flow loads without error

### Requirement: Factory members override step options per factory

A member with `steer` on the project SHALL be able to set, for their factory, a provider,
model and effort per agent step id of the factory's flow, and SHALL NOT be able to set a
permission mode or tool lists this way. An override SHALL be validated as a provider / model
pair the system supports. An override for a step id the run's flow does not have SHALL be
ignored and reported by flow validation. Overrides SHALL apply to runs admitted after they
are saved and to steps that have not started yet.

#### Scenario: A member picks a cheaper model for the CI fix

- **WHEN** a member sets the override `ci.before_retry → model: haiku` and a later run's CI fails
- **THEN** the fix step runs with `haiku` even though the flow file says another model

#### Scenario: A permission mode cannot be overridden from settings

- **WHEN** a client sends a step override that carries a permission mode
- **THEN** the settings save is refused with a validation error

#### Scenario: A viewer cannot change overrides

- **WHEN** a project member without `steer` saves step overrides
- **THEN** the save is refused with 403

### Requirement: A read-only step can run on its own thread

An agent step that sets `thread: new` SHALL run on a new thread of the enabler, on the same
runtime as the implementing thread, instead of continuing the implementing thread. Such a step
SHALL resolve to permission mode `plan` and SHALL start read-only (the runner holds the thread
to reading, `readOnly`), so it SHALL resolve to a provider that can be held to that (`claude`,
`codex`); a flow whose `thread: new` step resolves to any other mode or provider SHALL be refused
at load. Later steps without `thread: new` SHALL keep continuing the
implementing thread. The new thread SHALL be recorded with the run, stopped with the run, and
replayed (not started again) when the run resumes.

#### Scenario: A review on another provider

- **WHEN** a flow's `review` step sets `thread: new`, `provider: codex` and `permission_mode: plan`, and the next step continues the implementing thread with `{{review.output}}`
- **THEN** the review runs on its own thread with `codex`, and the follow-up on the implementing thread receives the review's final message

#### Scenario: A writing step on its own thread is refused

- **WHEN** a flow sets `thread: new` on a step whose resolved permission mode is `autoEdit`
- **THEN** the flow is refused with a message naming the step

#### Scenario: A resumed run does not start the review again

- **WHEN** the server restarts while a run's `thread: new` step has a recorded thread
- **THEN** the resumed run waits on that recorded thread and does not start another

### Requirement: Prompts can be loaded from files next to the flow

An agent step SHALL accept `prompt_file` instead of `prompt`, naming a file relative to the
flow's directory. For a repository flow the file SHALL be read from the repository's default
branch, like the flow; for a built-in flow, from the built-in flows' directory. A path that is
absolute, contains `..`, or does not exist SHALL make the flow fail to load with a message
naming the path. A step that sets both `prompt` and `prompt_file`, or neither, SHALL be refused.
The file's text SHALL be templated exactly like an inline prompt.

#### Scenario: A shared implement prompt

- **WHEN** a repository's `issue-to-pr.yaml` and `issue-to-merge.yaml` both set `prompt_file: prompts/implement.md`
- **THEN** both runs send the text of `.funny/workflows/prompts/implement.md` from the default branch, with its variables filled in

#### Scenario: A prompt file on the working branch is ignored

- **WHEN** a run's working branch edits `.funny/workflows/prompts/implement.md`
- **THEN** the run uses the default branch's version

#### Scenario: A path escaping the workflows directory is refused

- **WHEN** a step sets `prompt_file: ../../secrets.txt`
- **THEN** the flow fails to load with a message naming the path, and no thread starts

### Requirement: Runs record and show where their flow came from

A run SHALL record whether its flow came from the repository or was built in, the
default-branch commit the repository flow (and its prompt files) was read at, and the effective
options of each agent step it ran. The run list SHALL show the flow name, its source and commit,
and each agent step's provider, model, effort and permission mode. A resumed or retried run
SHALL keep the source it recorded when it started.

#### Scenario: The run row shows a repository flow

- **WHEN** a run executes `.funny/workflows/issue-to-merge.yaml` read at commit `abc1234`
- **THEN** the run row shows `issue-to-merge`, `repository`, `abc1234`, and the options of each agent step it ran

#### Scenario: A built-in flow is labelled

- **WHEN** a run executes the built-in `issue-to-pr`
- **THEN** the run row shows the source `built-in` and no commit

### Requirement: A factory's flow can be validated before a run

A member SHALL be able to validate a flow of their factory without starting a run. Validation
SHALL load the flow exactly as an admitted run would (default branch, prompt files, factory
checks, the factory's step overrides) and SHALL answer either the load error or a summary:
the flow's source and commit, and for each step its id, kind and, for agent steps, the
resolved options and thread. It SHALL also list step overrides that name no step of the flow.
Validation SHALL NOT start a thread or touch the repository.

#### Scenario: A broken repository flow is reported

- **WHEN** a member validates a factory whose repository flow has a YAML syntax error
- **THEN** validation answers the parse error with its location, and no run or thread is created

#### Scenario: A valid flow is summarized

- **WHEN** a member validates the built-in `issue-to-merge`
- **THEN** validation lists its steps with their kinds, and for each agent step its resolved options and whether it continues the implementing thread

#### Scenario: A stale override is reported

- **WHEN** the factory has an override for step `review` and the validated flow has no step `review`
- **THEN** the summary lists the `review` override as unused

### Requirement: Built-in flows recover a missing pull request

The built-in flows that open a pull request SHALL, when the agent finished without an open pull
request from the run's branch, send the implementing thread one follow-up asking it to push the
branch and open the pull request, and look again. If there is still no pull request, the run
SHALL fail as it does today.

#### Scenario: The agent forgot to open the pull request

- **WHEN** the implement step completes, the branch exists, and there is no open pull request from it
- **THEN** the implementing thread receives a follow-up asking it to open one, and the run continues to CI when it does

#### Scenario: Still no pull request after the follow-up

- **WHEN** the follow-up completes and there is still no open pull request from the branch
- **THEN** the run fails with the "the agent did not open one" reason

### Requirement: The CI fix step receives enough context to reproduce the failure

When `wait_ci` fails on red checks, the failure handed to the fix step SHALL name the commit
that was checked and, for each failing check (up to a bounded number), its name, a link to it,
the failed job step when the CI provider reports one, and a bounded tail of its log. The total
size SHALL stay bounded.

#### Scenario: A failing GitHub Actions job

- **WHEN** a GitHub Actions check fails in its `Run tests` step
- **THEN** the fix step's context names the head commit, the check, the step `Run tests`, a link to the check, and the end of its log

### Requirement: Run step timings

A factory run as the run lists return it (the caller's queue across projects and a project's run list) SHALL carry its step timings: one entry per execution of a node of its flow, in the order they started, with the node, the visit (a loop's iteration), the attempt, the status (running, succeeded, failed, skipped, cancelled), the start time and, once it ended, the end time. The timings SHALL come from the executions the workflow engine already records for the run; reading them SHALL NOT change the run. The entries SHALL carry no step output, error text or stored data. Other answers that return a run MAY omit the timings.

#### Scenario: A run in its second review round

- **WHEN** a run's flow ran triage, implement, pull-request, ci and review, then address and review again, and the second review is running
- **THEN** the run lists return seven entries in start order, the last one `review` with status running and no end time

#### Scenario: Nothing ran yet

- **WHEN** a run is still in the queue
- **THEN** the run lists return it with no step timings

### Requirement: Ready pull requests merge in tested batches

When the base branch does not require GitHub's merge queue, the system SHALL merge factory pull
requests of a repository and base branch in batches of up to the factory's batch size: it SHALL
build a temporary branch from the current base with each member merged in queue order, wait for
its checks, and merge the members in that order only when the checks are green and the base has
not moved since the batch was built. If the base moved, it SHALL rebuild the batch on the new
base. It SHALL build the batch on a staging ref that CI does not listen to and point the batch
branch at the finished commit, so CI runs once per batch. After merging it SHALL verify that the
resulting base matches the tested batch, and SHALL delete the temporary branches when the batch
ends. When the base branch requires pull requests to be up to date before merging, the system
SHALL use batches of one on it and SHALL NOT bypass the rule.

A batch SHALL be green only when the base branch's required checks, or, when it requires none,
the checks that reported on its members' pull requests, reported green on the batch commit; a
batch commit with no checks SHALL NOT count as green. The system SHALL merge a member only at the
head commit the batch tested, and SHALL rebuild the batch without a member whose run was stopped
or taken over or whose pull request head changed. When a member's merge is refused after earlier
members merged, the system SHALL stop merging that batch, record it, and test the remaining
members again on the new base.

#### Scenario: A green batch merges in one CI run

- **WHEN** runs #12, #13 and #14 wait to merge and the batch branch with all three is green
- **THEN** the three pull requests are merged in that order and only one CI run on the batch was needed

#### Scenario: Someone merges by hand during a batch

- **WHEN** the base moves while a batch's checks are running
- **THEN** no member is merged and the batch is rebuilt on the new base

#### Scenario: A branch that must be up to date before merging

- **WHEN** the base branch requires pull requests to be up to date and #12 and #13 are ready
- **THEN** #12 is updated, checked and merged on its own, then #13, and the readiness check says why batches are of one

#### Scenario: CI does not start on the batch branch

- **WHEN** no check reports on a batch commit
- **THEN** the batch is not merged, no member is sent back to its implementer, and the readiness check says CI did not run on the queue branch

#### Scenario: Someone pushes to a member's pull request during the batch

- **WHEN** #13's pull request gets a new commit while the batch of #12, #13 and #14 is being tested
- **THEN** #13 is not merged on that result and the batch is rebuilt with #12 and #14

#### Scenario: The run that leads a batch is stopped

- **WHEN** a member stops the run that is leading a batch of three
- **THEN** that run leaves the queue, and the other two wait again and are tested in a new batch

#### Scenario: A merge is refused in the middle of a batch

- **WHEN** #12 merged from a green batch and GitHub refuses to merge #13
- **THEN** #14 is not merged, the partial landing is recorded, and #13 and #14 are tested again on the new base

#### Scenario: A member that does not merge onto the batch

- **WHEN** #13 conflicts with the batch built from the base and #12
- **THEN** #13 leaves the batch and goes to the integrate step, and the batch continues with the others

### Requirement: A red batch is bisected

When a batch's checks are red, the system SHALL test the same tree once more and continue as
green if it passes. If still red, it SHALL test halves of the batch on their own branches from the same
base, in parallel, splitting every red half again until each member that makes the checks fail is
isolated; those members SHALL go back to their implementers with the failure. The other members
SHALL NOT merge on the result of their halves: they SHALL form a new batch that is built and
tested again before merging. When no half is red, the system SHALL split the batch into batches
of one.

#### Scenario: One member breaks the batch

- **WHEN** a batch of #12, #13 and #14 is red because of #14
- **THEN** the halves are tested, #14 goes back to its implementer with the failing checks, and #12 and #13 merge only after a new batch of the two is green

#### Scenario: Two members break the batch

- **WHEN** a batch of #12, #13, #14 and #15 is red because of #12 and #15
- **THEN** both halves are bisected, #12 and #15 go back to their implementers, and #13 and #14 form a new batch

#### Scenario: A flaky failure

- **WHEN** a batch is red and the second test of the same tree is green
- **THEN** the batch merges without bisection and the flake is counted in the run metrics

#### Scenario: Two members that only fail together

- **WHEN** a batch is red but both of its halves are green
- **THEN** its members are tested and merged as batches of one, in queue order

#### Scenario: A batch of one

- **WHEN** a batch with only #12 is red
- **THEN** #12 goes back to its implementer with the failing checks and no bisection runs

### Requirement: GitHub's merge queue is used only when required

The system SHALL hand factory pull requests to GitHub's merge queue only when the base branch's
rules require it, and SHALL otherwise use its own batches. It SHALL read the rules when each batch
starts.

#### Scenario: A repository that requires GitHub's merge queue

- **WHEN** the base branch's rules require the merge queue
- **THEN** the pull request is added to GitHub's merge queue and followed, and no funny batch is built

#### Scenario: A repository without that rule

- **WHEN** the base branch does not require the merge queue
- **THEN** funny's own batches are used

### Requirement: Conflicts are resolved deterministically before an agent

On a conflict with the base branch, the system SHALL first run an integrate step in the run's
worktree or sandbox: merge the base in (never a rebase) with the structural merge driver and
recorded resolutions, regenerate declared paths, run the declared integration checks and push.
Only a conflict that remains after that SHALL be sent to the implementer, with the conflicted
paths and the diff of the pull request that merged in between. A round that the integrate step
resolved SHALL NOT count against the run's limit of correction rounds. The merge driver and
recorded resolutions SHALL be configured for the run's own processes only; the system SHALL NOT
write them to the configuration of the user's repository.

#### Scenario: Adjacent additions resolved without an agent

- **WHEN** two runs added different imports next to each other in the same file and the structural driver merges them
- **THEN** the integrate step pushes the merge and the implementer is not asked

#### Scenario: Several resolved rounds do not park the run

- **WHEN** the integrate step resolves a conflict for the same run four times without the implementer
- **THEN** the run is not parked for exhausted rounds

#### Scenario: A worktree run leaves the user's git configuration alone

- **WHEN** the integrate step runs in a worktree of the user's local repository
- **THEN** the repository's git config and attributes files are unchanged afterwards

#### Scenario: A resolved conflict is reviewed again

- **WHEN** the integrate step resolved a conflict with the structural driver or a regenerator
- **THEN** the run passes the review gate again, with the reviewer limited to the resolved hunks and regenerated paths

#### Scenario: A clean merge of the base

- **WHEN** the integrate step merged the base in without any conflict
- **THEN** the earlier review still holds

#### Scenario: A real conflict

- **WHEN** both runs changed the same function body differently
- **THEN** the integrate step aborts the merge and the implementer receives the conflicted paths and the other pull request's diff

### Requirement: Declared paths are regenerated, never merged

The system SHALL read regenerators from `.funny/integrate.yaml` on the default branch, each a set
of paths and a command. When an integration conflict touches a declared path, the system SHALL
run that path's command in the run's worktree or sandbox and use its output, instead of merging
the file or asking an agent. A regenerator file that does not validate SHALL be reported when the
flow is validated and when a run loads it.

#### Scenario: A lockfile conflict

- **WHEN** `bun.lock` conflicts and `.funny/integrate.yaml` declares `bun.lock` → `bun install`
- **THEN** `bun install` runs in the run's worktree, its lockfile is used, and no agent is asked

### Requirement: Factory flows may run commands in the run's own workspace

The system SHALL accept `run_command` steps in factory flows read from the default branch, and
SHALL run them only in the run's own worktree or sandbox on the enabler's runner, never on the
server, with a timeout (10 minutes unless the step sets one), recording the command's output on
the run, bounded, with the values of the secrets in the step's environment masked, and failing
the step on a non-zero exit or the timeout.

#### Scenario: A codemod step

- **WHEN** a flow's step runs `bunx oxlint --fix` and it exits 0
- **THEN** it ran in the run's worktree and its output is recorded on the run

#### Scenario: A command that prints its environment

- **WHEN** a `run_command` step runs `env`
- **THEN** the recorded output shows the App installation token masked

#### Scenario: A command that hangs

- **WHEN** a `run_command` step is still running after its timeout
- **THEN** its process is killed and the step fails with the timeout as the reason

### Requirement: Regenerable changes are re-run on the new base

A flow MAY mark its `merge` step with the step that produces the change. When such a run hits an
integration conflict, the system SHALL re-run that step on the current base instead of the
integrate step or the implementer, and SHALL put such runs in a batch of their own.

#### Scenario: A repository-wide lint fix

- **WHEN** a run whose change comes from `oxlint --fix` conflicts with a merge that landed before it
- **THEN** the command runs again on the new base, the result is pushed, and no conflict is resolved by hand

### Requirement: Runs are integrated early when a merge affects them

When a pull request merges into a repository, the system SHALL check, without pushing or running
checks, whether the factory runs in flight whose changed paths overlap it still merge, and SHALL
run the integrate step on those that no longer do, before they reach the merge queue. It SHALL
NOT run the integrate step in a worktree or sandbox while an agent step or command of that run
is active: it SHALL run it when that step ends. A run that is waiting for its checks SHALL be
judged on the new head.

#### Scenario: A conflict found while the implementer is still working

- **WHEN** #12 merges and run #13, still being reviewed, no longer merges cleanly
- **THEN** the integrate step runs on #13 then, and any remaining conflict goes to its implementer before #13 reaches the queue

#### Scenario: A merge that affects a run waiting for its checks

- **WHEN** #12 merges and the integrate step pushes a merge commit to run #13 while it waits for CI
- **THEN** #13 waits for the checks of the new head and the old head's checks decide nothing

#### Scenario: A merge that affects a run whose agent is working

- **WHEN** #12 merges and the implementer of run #13 is still editing its worktree
- **THEN** #13 is marked for integration and the integrate step runs when the implementer's step ends, not during it

### Requirement: Dependent issues can be stacked

A factory SHALL support `dependencies: wait` (the default: an issue waits until its blockers are
finished) and `dependencies: stack`. With `stack`, an issue whose blocker has a run in flight with
a branch SHALL start on top of the blocker's branch with its pull request against it; the queue
SHALL merge the blocker first, and the stacked run SHALL park in `waiting_human` if the blocker's
run fails or is stopped or its pull request is closed without merging. The system SHALL bring
each new commit of the blocker's branch into the runs stacked on it, SHALL NOT put a stacked run
in the same batch as its blocker, and, once the blocker merged, SHALL retarget the stacked pull
request to the base branch and bring the base in before the run enters the queue.

#### Scenario: Work on a dependent issue starts early

- **WHEN** issue #21 is blocked by #20, #20's run is in flight, and the factory uses `stack`
- **THEN** #21's implementer starts on #20's branch instead of waiting for #20 to merge

#### Scenario: The blocker is squash-merged

- **WHEN** #20 is squash-merged while #21 is stacked on it and already contains #20's last commit
- **THEN** #21's pull request is retargeted to the base branch, the base merges into it without a conflict from #20's own changes, and #21 then enters the queue

#### Scenario: The blocker gets a fix after the stacked run started

- **WHEN** #20's implementer pushes a review fix while #21 is stacked on it
- **THEN** the fix is merged into #21's branch by the integrate step, not left for merge time

#### Scenario: The blocker fails

- **WHEN** #20's run fails while #21 is stacked on it
- **THEN** #21 parks in `waiting_human` with the blocker's failure as the reason

### Requirement: The queue orders and groups its members

The merge queue SHALL take a blocker before the runs stacked on it or blocked by it, then
admission order, letting a much smaller change go before a much larger one, and SHALL prefer
batches whose members change disjoint paths.

#### Scenario: A small fix behind a large refactor

- **WHEN** a 30-line fix and a 900-line refactor wait to merge and neither blocks the other
- **THEN** the fix is taken first

### Requirement: The factory shows whether a repository is ready for the queue

The factory settings SHALL show, per repository, whether its CI runs on the queue's temporary
branches, whether a structural merge driver is available on the enabler's runner, its median CI
time against the batch wait, whether its base branch requires GitHub's merge queue, and whether
it requires pull requests to be up to date before merging (batches of one). When CI
does not run on the temporary branches, the system SHALL NOT start batches for that repository,
SHALL say why, and SHALL offer to open a pull request that adds the trigger.

#### Scenario: CI does not run on the queue's branches

- **WHEN** a repository's workflows do not trigger on `factory/queue/**`
- **THEN** the settings show it, no batch starts, and the member can open the pull request that adds the trigger

### Requirement: Integration is measured per run and per factory

Each run SHALL record integrate rounds, conflicts resolved without an agent, conflicts sent to the
implementer, its queue wait, the size of the batch that merged it, its bisection rounds and the
batch failures that passed on a second test, in addition to its CI counters. Counters missing from older runs SHALL read as 0. The factory's
30-day summary SHALL show conflicts resolved without an agent, the median queue wait, the average
batch size and the share of batches that needed bisection.

#### Scenario: A conflict resolved by the structural driver

- **WHEN** the integrate step resolves a conflict without the implementer
- **THEN** the run's count of conflicts resolved without an agent goes up by one and the summary includes it
