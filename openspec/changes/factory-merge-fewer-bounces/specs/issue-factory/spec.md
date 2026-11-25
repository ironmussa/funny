# Spec Delta

## ADDED Requirements

### Requirement: A merge refused because a branch moved is tried again

When GitHub refuses to merge a run's proved commit, the system SHALL find out whether the base
branch or the pull request's head moved since that commit was proved. If either did, the system
SHALL send the run back through integration (the base brought in, the checks, the proof) and
SHALL try the merge again, without parking the run and without a person; a merge approval in
force SHALL follow the new commit under the rules that already decide it. After three such
refusals within one visit to `merge`, the run SHALL park in `waiting_human` saying the base
keeps moving. A refusal with neither branch moved SHALL park the run with GitHub's reason, as
before.

#### Scenario: The base moved a minute before the merge

- **WHEN** a member pushes to the base branch after a run's commit was proved, and GitHub
  answers 405 to the merge of that commit
- **THEN** the run brings the base in, waits for the checks on the new commit and merges it,
  and it is never shown as waiting for a person

#### Scenario: The approval follows the retried merge

- **WHEN** the refused run is high risk, a member approved the refused commit, and the base
  merges in without changing what the pull request adds and removes
- **THEN** the approval moves to the new commit and the run merges without a second approval

#### Scenario: A branch rule

- **WHEN** GitHub refuses a merge because a rule requires a review, and neither the base nor
  the head moved since the commit was proved
- **THEN** the run parks in `waiting_human` with GitHub's reason and is not tried again

#### Scenario: The base keeps moving

- **WHEN** GitHub refuses a run's merge three times in one visit to `merge`, the base having
  moved each time
- **THEN** the run parks in `waiting_human` with a reason saying the base branch keeps moving

### Requirement: A hold after a lost approval says what changed since the approved commit

When the system holds a high-risk change for a person and a member had approved another commit
of the same pull request that does not cover the held one, the hold SHALL record, computed
without an agent: the approved commit, who approved it, how many lines of the change differ
between the two commits, the files in which it differs (at most 20, and how many more), which
of those files the approved change did not touch, the risk reasons the approved commit did not
have, and why the approval did not follow. Wherever a member is asked to approve that hold (the
approval request in a thread, the factory board, the agent's run list) the system SHALL show
that record before the change's risk reasons. An approval SHALL still be given for the
held commit as a whole, and SHALL become the commit later adjustments are compared with. When
the difference could not be computed, the hold SHALL say so and SHALL show the change as for a
first approval. A hold with no earlier approval SHALL carry no such record.

#### Scenario: A fix in a file the approval did not cover

- **WHEN** a member approved commit A of a 700-line pull request, an agent then changed 8 lines
  in `src/ports/factory.ts`, which A's change did not touch, and the run is held on commit B
- **THEN** the hold says the member approved A, that 8 lines differ in `src/ports/factory.ts`,
  that A's change did not touch that file, and that this is why the approval did not follow

#### Scenario: An adjustment over the limit

- **WHEN** the factory follows adjustments of 30 lines, a member approved commit A, and the
  change at the held commit B differs by 61 lines in two files A's change already touched
- **THEN** the hold says 61 lines differ, names the two files, and says the factory follows 30

#### Scenario: The member approves the difference

- **WHEN** a member approves commit B from a hold that showed the difference from A
- **THEN** the approval is recorded for B, and a later adjustment is measured from B

#### Scenario: A first approval

- **WHEN** a high-risk run is held and no member approved any commit of its pull request
- **THEN** the hold shows the change's size and risk reasons and nothing about a difference

#### Scenario: The comparison is not available

- **WHEN** a member approved commit A and the runner cannot compare it with the held commit B
- **THEN** the hold says the difference from A could not be computed, and shows B's size and
  risk reasons

### Requirement: A run with a pull request does not wait for paths

A run that already has an open pull request SHALL NOT wait in the queue because its likely
paths overlap another run's: when it is retried or resumed it SHALL go on from its flow's step,
and it SHALL hold its own paths as a run in that step does. The order of merges SHALL stay the
order in which runs were admitted.

#### Scenario: An approved run is retried while a later run works on the same file

- **WHEN** run #12, admitted first, has an open pull request and a member's approval, run #13
  is working on a file #12's contract lists, and #12 is retried
- **THEN** #12 goes on to integration and merge without waiting for #13

#### Scenario: A run without a pull request still waits

- **WHEN** run #14 has a contract and no pull request, and its likely paths overlap run #12,
  which is working
- **THEN** #14 waits in the queue with the reason naming #12

## MODIFIED Requirements

### Requirement: Runs with overlapping paths do not work at the same time

After triage, the system SHALL NOT start the implementer of a run whose contract's likely paths
overlap the likely paths of another run of the same factory that is changing files (working,
with its pull request open or waiting for its checks, fixing, reviewing or merging). Such a run SHALL release its slot and wait in the queue, keeping its
contract, with a reason naming the run it waits for. A run without a contract SHALL neither hold
paths nor wait for them.

A factory SHALL have a setting, off by default, to keep the paths of a run that is parked for a
member's approval of a high-risk change. With it on, such a run SHALL hold its likely paths
while it waits, for at most 12 hours from the moment it parked; a run parked for any other
reason SHALL hold none. The reason shown on a run that waits for it SHALL say the other run is
waiting for an approval.

#### Scenario: Two issues touch the same file

- **WHEN** run #12 is working with likely path `src/db/migrate.ts` and run #13's triage lists
  the same path
- **THEN** run #13 waits with the reason "paths overlap #12" and starts after #12 leaves those
  states, without being triaged again

#### Scenario: A run waiting for its approval keeps its paths

- **WHEN** a factory has the setting on, run #12 parked for an approval one hour ago with likely
  path `src/db/migrate.ts`, and run #13's triage lists the same path
- **THEN** run #13 waits in the queue with a reason saying #12 is waiting for an approval

#### Scenario: The approval does not come

- **WHEN** run #12 has been parked for an approval for more than 12 hours
- **THEN** run #13 starts, although #12 is still parked

#### Scenario: Parked for another reason

- **WHEN** a factory has the setting on and run #12 parked because its review rounds ran out
- **THEN** run #12 holds no paths

#### Scenario: The setting is off

- **WHEN** a factory has the setting off and run #12 is parked for an approval
- **THEN** run #12 holds no paths and run #13 starts
