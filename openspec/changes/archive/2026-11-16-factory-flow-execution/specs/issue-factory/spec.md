# Spec Delta

## Purpose

The in-server issue factory watches a project's repository for labelled issues and runs a
configured workflow for each — implementing the change, opening a pull request, waiting on
CI, and merging — where the workflow, not a fixed setting, decides how far a run goes.

## ADDED Requirements

### Requirement: Admitted issues run the configured flow

When the factory admits an issue, the system SHALL execute the factory's configured flow
(by name, default `issue-to-merge`) through the workflow engine, as the enabling user on
their runtime, rather than running a single fixed implement step. A run SHALL record the
flow's progress (current step and the thread ids it spawned) so it can be observed and
resumed-from-terminal.

#### Scenario: An admitted issue starts its flow

- **WHEN** the watcher admits an open, labelled issue with no active run and under the concurrency cap
- **THEN** the system starts the factory's configured flow for that issue and records a run whose state reflects the flow's first step

#### Scenario: A missing or unparseable flow fails the run with a clear reason

- **WHEN** the configured flow name cannot be found or compiled
- **THEN** the run is marked failed with a message naming the flow, and no thread is started

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
