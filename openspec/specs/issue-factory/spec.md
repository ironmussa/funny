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

A `merge` workflow step SHALL merge the run's pull request (directly, or by enabling
auto-merge when the repository requires it) only after its checks are green, optionally
deleting the working branch, and SHALL mark the run merged on success. A `merge` step SHALL
NOT merge a pull request whose required checks are not green.

#### Scenario: A green PR is merged and the run completes

- **WHEN** a `merge` step runs on a PR whose required checks are green
- **THEN** the PR is merged (or auto-merge is enabled) and the run is marked merged

#### Scenario: Merge is refused when checks are not green

- **WHEN** a `merge` step runs on a PR whose required checks are not green
- **THEN** the step does not merge and the run does not reach the merged state

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
