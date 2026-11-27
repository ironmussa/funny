# Spec Delta

## ADDED Requirements

### Requirement: Triage closes an issue with nothing to change

A `triage` step SHALL also be able to answer `not_actionable` with evidence, for an issue that
no change to the repository would fix. The system SHALL then post one comment on the issue from
a fixed template with the evidence (at most five items of at most 300 characters, mentions and
links removed), close the issue as not planned and end the run `done`, holding no concurrency
slot. When the issue cannot be closed, the comment SHALL say so and the run SHALL park in
`needs_info`. An issue closed on an `already_done` answer SHALL still be closed as completed.

#### Scenario: A failure outside the code

- **WHEN** triage answers `not_actionable` with two items of evidence
- **THEN** the issue gets one comment listing them, is closed as not planned, and its run is
  `done`

#### Scenario: The issue cannot be closed

- **WHEN** triage answers `not_actionable` and GitHub refuses the close
- **THEN** the comment asks a person to close the issue and the run is in `needs_info`

### Requirement: A run held for its paths is triaged again when those files changed

A run that leaves its slot because its likely paths overlap a run in progress SHALL keep its
contract, marked as held in the same write as the move. When that run is admitted again and no
run in progress holds its paths, the system SHALL triage it again on a new thread if a run of
the same factory merged into the same base branch since the contract was written and changed a
path the contract names; the stored answer of the earlier triage SHALL NOT be read again.
Otherwise the run SHALL go on with its contract. The mark SHALL be cleared once this is decided,
so a run resumed later is not triaged again. A contract that came from an approved spec SHALL be
kept. When the second triage cannot start or gives no valid answer, the run SHALL go on with
its earlier contract.

#### Scenario: A duplicate of an issue that merged meanwhile

- **WHEN** two issues name the same file, the first run merges while the second waits, and the
  second triage answers `already_done`
- **THEN** the second issue is closed with the evidence, its run is `done`, and no implementer
  starts for it

#### Scenario: The blocking run ended without merging

- **WHEN** a held run is admitted again and no run merged on its paths
- **THEN** it starts its implementer with the contract it already had, without a new triage
