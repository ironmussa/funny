# Spec Delta

## MODIFIED Requirements

### Requirement: Factory agents have separate roles and see only stored results

A factory run SHALL use agents in five roles: triage, spec writer, implementer, reviewer and
sentinel. Only the implementer SHALL write to the run's branch. No agent SHALL merge a pull
request, approve it, approve a spec, or publish a status or comment on GitHub; the server SHALL
do those. Triage, spec writer, reviewer and sentinel SHALL each run on a new thread in a
read-only permission mode with write tools denied, whatever the flow says. An agent SHALL receive
another role's result only as the validated result the server stored, and SHALL NOT be given
another agent's thread.

#### Scenario: The reviewer cannot write

- **WHEN** a repository flow sets `permission_mode: autoEdit` on its `review` step
- **THEN** the flow is refused when it loads, naming the step and the field

#### Scenario: The reviewer does not see the implementer's thread

- **WHEN** the review step of a run starts
- **THEN** its prompt contains the run's contract (or, for a run without one, the issue's URL),
  the commit to review and the pull request, and no message from the implementer's thread

#### Scenario: The implementer does not see the spec writer's thread

- **WHEN** the implementer of a run with an approved spec starts
- **THEN** its prompt contains the approved spec and no message from the spec writer's thread

### Requirement: Triage decides whether an issue can be worked unattended

A flow's `triage` step SHALL run before any implementer step and SHALL answer `ready` with a
contract (acceptance criteria, likely paths, risk hints), `needs_info` with questions,
`too_big` with a proposed split, or, when the factory's Spec stage is on, `needs_spec` with the
open product decisions. On `ready` the system SHALL store the contract on the run and pass it to
the implementer and the reviewer. On `needs_info` or `too_big` the system SHALL post one comment
on the issue from a fixed template, with at most five questions or parts of at most 300
characters each, with mentions and links removed, and SHALL park the run in `needs_info`,
holding no concurrency slot. On `needs_spec` the system SHALL post nothing on the issue and SHALL
start the spec stage (capability `factory-spec`). A run whose spec was approved SHALL NOT be
triaged again: its stored contract comes from the spec.

When the factory's `tooBig` setting is `split` (default `ask`), a `too_big` answer SHALL instead
open one issue per part (the same sanitized parts; the parent's description, mentions removed,
for context; a marker naming the parent), queue them in the same factory with the run's flow,
comment the list on the parent, take the factory's label off it and end the run `done`. A part
the factory opened SHALL never be split automatically again: its `too_big` answer is commented
as with `ask`. When no part can be opened the split SHALL be commented as with `ask`; when only
some can, the opened ones are queued and the comment names the rest for a person. The parts
opened are recorded on the run as each one opens, so a resumed run does not open them twice.

#### Scenario: The factory splits a too-large issue

- **WHEN** the factory's `tooBig` is `split` and triage answers `too_big` with two parts
- **THEN** two issues are opened and queued in the factory, the parent gets one comment listing
  them, loses the factory's label, and its run is `done`

#### Scenario: A part is not split again

- **WHEN** triage answers `too_big` on an issue the factory opened as a part
- **THEN** the split is commented on it and its run is in `needs_info`

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

#### Scenario: Open product decisions

- **WHEN** the factory's Spec stage is on and triage answers `needs_spec`
- **THEN** the run is in `needs_spec`, the issue gets no comment, and a spec writer starts

### Requirement: The review judges one commit against the contract

A flow's `review` step SHALL judge the pull request's head commit against the run's contract,
or against the issue when the run has no contract, answering `pass` or `fail` with findings that
each carry a severity. For a run with an approved spec, the reviewer SHALL also receive the spec
and SHALL answer every item of its validation checklist as met or not met; a result that leaves
an item unanswered SHALL be invalid, and each item not met SHALL count as a `high` finding. The
verdict SHALL hold only for the commit it names. The system SHALL start the review of a head
commit when that commit's checks start, unless the step sets `early: false` or the factory's
review limit has no free slot, and SHALL stop a review and discard its result when the head
commit changes while it runs. A pull request SHALL NOT be merged on a verdict alone: the checks
of the same commit SHALL be green too. A `fail` with a critical or high finding SHALL send the
findings to the implementer as a follow-up, after which the checks and the review SHALL run
again on the new head commit, up to the review loop's limit (three reviews by default); a `fail`
with only lower findings SHALL count as a pass. When the rounds run out the run SHALL park in
`waiting_human`.

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

#### Scenario: A validation item is not met

- **WHEN** the reviewer of a run with an approved spec answers `pass` and marks one validation
  item not met
- **THEN** the verdict does not allow the merge and the item goes to the implementer as a high
  finding

#### Scenario: A validation item is left out

- **WHEN** the reviewer's result answers two of a spec's three validation items
- **THEN** the result is invalid and the reviewer is asked once to emit it again
