# Spec Delta

## ADDED Requirements

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
overlap the likely paths of another run of the same repository that is working, fixing,
reviewing or merging. Such a run SHALL release its slot and wait in the queue, keeping its
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
when it has any such finding, exceeds 400 changed lines, touches a default or
factory-configured sensitive path, or the contract lists a risk hint, and `low` otherwise. No
agent result SHALL lower the risk class.

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

## MODIFIED Requirements

### Requirement: `merge` integrates a green pull request

A `merge` workflow step SHALL merge the run's pull request only when all of these hold: the
pull request's head commit has a passing review (unless the step sets `require_review: false`),
the change's risk class is allowed by the factory's auto-merge setting (`low_risk` by default,
or `all`), and the pull request's checks are green on a commit that is up to date with the
current base branch, reached through the repository's merge lane. Only a verdict of the flow's
own `review` step SHALL count as that review: a check, status, comment or approval that an
external reviewer (a review bot such as CodeRabbit, or any other app) leaves on the pull request
is a check like any other and SHALL NOT stand in for it. It MAY delete the working
branch, and SHALL mark the run merged on success. A `merge` step SHALL NOT merge a pull request
whose required checks are not green. A run whose review is missing or not passing, or whose risk
class is not allowed, SHALL park in `waiting_human` with that reason.

#### Scenario: A green PR is merged and the run completes

- **WHEN** a `merge` step runs on a PR whose head commit passed review, whose risk class is
  `low`, and whose checks are green on the current base
- **THEN** the PR is merged (or GitHub's merge queue merges it) and the run is marked merged

#### Scenario: Merge is refused when checks are not green

- **WHEN** a `merge` step runs on a PR whose required checks are not green
- **THEN** the step does not merge and the run does not reach the merged state

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
