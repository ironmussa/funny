# Spec Delta

## MODIFIED Requirements

### Requirement: A merge approval may follow a small adjustment

A factory SHALL have a setting for the largest adjustment an approval follows, in lines, off by
default and at most 200. With it on, an approval of commit A SHALL cover a later head commit B
that descends from A when every one of these holds: the pull request's change at B differs from
its change at A by no more lines than the setting (lines added to or dropped from the change);
every file in which the changes differ is either a file the change at A already touched or a
file the base brought (below); and B's risk classification gives no reason that A's did not
have, a larger size alone not being a new reason. The difference SHALL always be measured
against the commit the member approved, not against a commit the approval moved to. The review,
the checks and the proof of B SHALL still be required. An approval recorded before this setting
existed SHALL follow only the same change.

A file the base brought is a file that the base branch changed between the commit where A split
from it and the commit where B split from it, and from which the change at B removes only lines
that the base added in that range. A file the base did not change in that range, or from which
the change at B removes a line the base did not add, SHALL NOT be covered.

A line that the change at A added or removed in one file, and that the change at B adds or
removes in a file the base brought, SHALL count once as the same edit (it moved with its code),
not as a line dropped from one file and a line added to another. Between two files that the
change at A both touched, lines SHALL still be compared file by file.

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

- **WHEN** commit B changes 5 lines in a file that the change at A did not touch and that the
  base did not change after A split from it
- **THEN** the approval does not cover B

#### Scenario: The implementer fixes code the base brought

- **WHEN** a factory allows 100 lines, a member approved commit A of a change that clears a lint
  rule, the base then gains a file with a new warning of that rule, and commit B merges the base
  and changes 2 lines of that file, removing only a line the base added
- **THEN** the approval covers B, and the moved-approval record lists the file as code the base
  brought

#### Scenario: An edit in base code the change did not add

- **WHEN** commit B changes a file the base changed after A split from it, and removes from it a
  line that was there before A split from the base
- **THEN** the approval does not cover B

#### Scenario: An edit that moved with its code

- **WHEN** the change at A edits 19 lines of file F, the base then moves that code from F to a
  new file G, and commit B carries the same 19 edits in G
- **THEN** those edits count as no difference, and only lines B changes beyond them count
  toward the limit

#### Scenario: A new risk reason

- **WHEN** commit B changes 4 lines in files A touched, and one of them adds a skip marker to a
  test that A's classification did not report
- **THEN** the approval does not cover B

#### Scenario: A sensitive file the base brought

- **WHEN** the file the base brought matches one of the factory's sensitive paths, and A's
  classification did not report that path
- **THEN** the approval does not cover B

#### Scenario: Adjustments do not add up

- **WHEN** a factory allows 50 lines, the approval of A moved to B for a 40-line difference,
  and commit C differs from B by 30 lines and from A by 70
- **THEN** the approval does not cover C

#### Scenario: A runner without the new comparison

- **WHEN** the runner that compares A and B does not report which files the base brought
- **THEN** the approval follows B only under the file-by-file rule: every differing file must be
  one the change at A touched

#### Scenario: The setting is off

- **WHEN** a factory leaves the setting off and commit B differs from A's change by 3 lines
- **THEN** the approval does not cover B
