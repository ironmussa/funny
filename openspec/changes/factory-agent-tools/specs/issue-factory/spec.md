# Spec Delta

## ADDED Requirements

### Requirement: A merge approval names the commit the member saw

An approval of a held high-risk change SHALL carry the commit the member was shown. The factory
SHALL record the approval only when that commit is the one the run is held on, and SHALL refuse
it otherwise without recording anything. The board and every other surface that offers the
approval SHALL send the commit it displays.

#### Scenario: The held commit is the one shown

- **WHEN** a member approves a run showing commit A and the run is held on A
- **THEN** the approval is recorded for A

#### Scenario: The held commit changed

- **WHEN** a member approves a run showing commit A and the run is now held on commit B
- **THEN** the approval is refused, nothing is recorded, and the member is told the change was
  updated
