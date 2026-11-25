# Spec Delta

## ADDED Requirements

### Requirement: A member approves merging a held high-risk change

When a run parks in `waiting_human` because its change is high risk and the factory merges only
low-risk changes by itself, a member with `steer` on the project SHALL be able to approve
merging it. The approval SHALL name the pull request's head commit at that moment and who
approved it, and the run SHALL then be retried. `merge` SHALL let a high-risk change through
only on a commit its approval covers; the review, the checks on the current base and the
regression proof of that commit SHALL still be required. An approval SHALL NOT be accepted for
a run that is not waiting for it.

#### Scenario: An approved change merges

- **WHEN** a member with `steer` approves a run held as high risk on commit A, and A is up to
  date with its base with green checks, a passing review and a passing proof
- **THEN** the run merges commit A

#### Scenario: A run that is not waiting

- **WHEN** a member approves a run that is working, or one parked for another reason
- **THEN** the approval is refused and nothing is recorded as approved

#### Scenario: A member without steer

- **WHEN** a member with only `view` on the project approves a held run
- **THEN** the approval is refused

### Requirement: A high-risk change is held on a head that includes its base

Before `merge` parks a high-risk change for a person, the system SHALL bring the pull request
up to date with its base branch when it is behind, and SHALL park the run on the resulting head
commit without waiting for that commit's checks. When the base cannot be brought in without a
code change, the run SHALL go on as for any integration conflict and SHALL be held once its
head includes the base. This SHALL NOT apply where the base branch requires GitHub's merge
queue, which tests the change on the current base itself.

#### Scenario: The head is behind when the hold is decided

- **WHEN** a high-risk run without an approval reaches `merge` with head commit A, three
  commits behind its base, and the base merges in without a conflict as commit B
- **THEN** the run parks for a person on commit B, and an approval of B needs no further base
  merge unless the base moves again

#### Scenario: The base conflicts

- **WHEN** a high-risk run without an approval reaches `merge` and the base does not merge in
  cleanly
- **THEN** the conflict goes to the flow's integration as for any other run, and the run asks
  for a person only on a head commit that includes the base

#### Scenario: The head is already current

- **WHEN** a high-risk run without an approval reaches `merge` on a head that includes its base
- **THEN** the run parks on that commit and nothing is pushed

### Requirement: A merge approval follows the same change to a new commit

An approval of commit A SHALL cover a later head commit B when B descends from A and the pull
request's change against its base (the lines it adds and removes, per file) is the same at A
and at B. This SHALL hold whoever merged the base in and whatever that merge settled. When the
comparison cannot be made (A is not an ancestor of B, the run's workspace is gone, the runner
does not answer), the approval SHALL NOT cover B. An approval that covers B SHALL be recorded
as approving B, keeping the commit the member approved.

#### Scenario: A conflict settled without an agent

- **WHEN** a member approved commit A, the base moved, and bringing it in settled a conflict in
  one file mechanically, giving commit B with the same added and removed lines as A
- **THEN** after B's review and checks pass, the run merges B without asking the member again

#### Scenario: The agent changes the change

- **WHEN** a member approved commit A and the implementer pushes commit B that adds lines A did
  not have, in a factory that does not allow adjustments
- **THEN** the run parks in `waiting_human` for an approval of B

#### Scenario: Rewritten history

- **WHEN** a member approved commit A and the branch is force-pushed to commit B that does not
  descend from A
- **THEN** the approval does not cover B

#### Scenario: The comparison is not available

- **WHEN** the runner that holds the run's workspace is offline when `merge` checks commit B
- **THEN** the run parks in `waiting_human` for an approval of B, and no other runner is asked

### Requirement: A merge approval may follow a small adjustment

A factory SHALL have a setting for the largest adjustment an approval follows, in lines, off by
default and at most 200. With it on, an approval of commit A SHALL cover a later head commit B
that descends from A when every one of these holds: the pull request's change at B differs from
its change at A by no more lines than the setting (lines added to or dropped from the change);
the differing lines are only in files the change at A already touched; and B's risk
classification gives no reason that A's did not have, a larger size alone not being a new
reason. The difference SHALL always be measured against the commit the member approved, not
against a commit the approval moved to. The review, the checks and the proof of B SHALL still
be required. An approval recorded before this setting existed SHALL follow only the same
change.

#### Scenario: A lint fix after the base moved

- **WHEN** a factory allows adjustments of 50 lines, a member approved commit A, and after a
  base merge the implementer pushes commit B that changes 7 lines in files A already touched,
  with no new risk reason
- **THEN** after B's review and checks pass, the run merges B without asking the member again

#### Scenario: A rewrite

- **WHEN** the same factory's implementer pushes commit B whose change differs from A's by 852
  lines
- **THEN** the run parks in `waiting_human` for an approval of B

#### Scenario: A file the approval did not cover

- **WHEN** commit B changes 5 lines in a file that the change at A did not touch
- **THEN** the approval does not cover B

#### Scenario: A new risk reason

- **WHEN** commit B changes 4 lines in files A touched, and one of them adds a skip marker to a
  test that A's classification did not report
- **THEN** the approval does not cover B

#### Scenario: Adjustments do not add up

- **WHEN** a factory allows 50 lines, the approval of A moved to B for a 40-line difference,
  and commit C differs from B by 30 lines and from A by 70
- **THEN** the approval does not cover C

#### Scenario: The setting is off

- **WHEN** a factory leaves the setting off and commit B differs from A's change by 3 lines
- **THEN** the approval does not cover B

### Requirement: A moved merge approval is recorded where the approver sees it

Each time an approval moves to another commit, the system SHALL record the commit the member
approved, the commit it moved to and, for an adjustment, the files and the number of lines that
differ. It SHALL post that as a comment on the pull request, saying the comment is automated
and that no person approved the new commit; it SHALL add it to the approver's activities; and
the run's detail SHALL show it. A failure to post the comment SHALL NOT stop the merge and
SHALL be logged.

#### Scenario: An adjustment is visible

- **WHEN** an approval of commit A moves to commit B for a 7-line difference in two files
- **THEN** the pull request has a comment naming A, B, the two files and the 7 lines, the
  approver's activities list the move, and the run detail shows "approved at A, moved to B"

#### Scenario: The same change

- **WHEN** an approval of commit A moves to commit B with the same change
- **THEN** the run detail and the approver's activities show the move, and the pull request
  comment says the change is the same
