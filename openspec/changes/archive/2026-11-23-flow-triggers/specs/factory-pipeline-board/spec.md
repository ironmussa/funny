# Spec Delta

## ADDED Requirements

### Requirement: Runs without an issue

A run that has no issue SHALL be shown, on its card, in the list and in the run panel, by
its trigger's name (or "Run now" and the flow's name for a run a member started) in place of
the issue number and title, with no issue link. The panel SHALL list the run's input values
and SHALL omit the triage, regression proof and review sections. The board SHALL place a run
in the state `done` in the Done column.

#### Scenario: A scheduled run's card

- **WHEN** the board shows a run started by the schedule trigger "Nightly audit"
- **THEN** its card shows "Nightly audit" where an issue run shows its issue number, and no issue link

#### Scenario: A finished scheduled run

- **WHEN** a scheduled run ends in the state `done`
- **THEN** it appears in the Done column
