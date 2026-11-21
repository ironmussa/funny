# semantic-validation Specification

## Purpose

TBD - created by archiving change evflow-smart-validator. Update Purpose after archive.

## Requirements

### Requirement: Sequence ordering validation

The validator SHALL check each consecutive pair of elements in a sequence and emit a `SEQUENCE_INVALID_TRANSITION` warning when the transition violates Event Modeling semantics. Valid transitions: command→event, event→command, event→readModel, event→event, readModel→command. All other transitions are invalid.

#### Scenario: Command followed by command

- **WHEN** a sequence contains `CommandA -> CommandB` (command directly followed by command)
- **THEN** the validator SHALL emit a warning with code `SEQUENCE_INVALID_TRANSITION` and a message indicating a missing event between the two commands

#### Scenario: ReadModel followed by event

- **WHEN** a sequence contains `CartView -> ItemAdded` (readModel followed by event)
- **THEN** the validator SHALL emit a warning with code `SEQUENCE_INVALID_TRANSITION` indicating read models do not produce events

#### Scenario: ReadModel followed by readModel

- **WHEN** a sequence contains `CartView -> OrderView` (readModel followed by readModel)
- **THEN** the validator SHALL emit a warning with code `SEQUENCE_INVALID_TRANSITION`

#### Scenario: Command followed by readModel

- **WHEN** a sequence contains `AddItem -> CartView` (command followed by readModel)
- **THEN** the validator SHALL emit a warning with code `SEQUENCE_INVALID_TRANSITION` indicating a missing event between command and read model

#### Scenario: Valid transitions produce no warnings

- **WHEN** a sequence contains `AddItem -> ItemAdded -> CartView` (command→event→readModel)
- **THEN** the validator SHALL NOT emit any `SEQUENCE_INVALID_TRANSITION` warnings

#### Scenario: Event followed by event is allowed

- **WHEN** a sequence contains `OrderPlaced -> OrderConfirmed` (event followed by event)
- **THEN** the validator SHALL NOT emit a `SEQUENCE_INVALID_TRANSITION` warning

#### Scenario: Sequences with unknown elements are skipped

- **WHEN** a sequence step references an element that does not exist in the model
- **THEN** the transition check SHALL skip that pair (the existing `SEQUENCE_UNKNOWN_ELEMENT` rule already handles it)

### Requirement: Automation cycle detection

The validator SHALL detect circular dependencies in automation chains and emit an `AUTOMATION_CYCLE` warning. It SHALL build a directed causality graph using sequences (to infer command→event edges) and automations (for event→command edges), then detect cycles via depth-first search.

#### Scenario: Simple two-node cycle

- **WHEN** a sequence defines `PlaceOrder -> OrderPlaced` AND an automation listens on `OrderPlaced` and triggers `PlaceOrder`
- **THEN** the validator SHALL emit a warning with code `AUTOMATION_CYCLE` and a message describing the cycle path (e.g., "PlaceOrder -> OrderPlaced -> PlaceOrder")

#### Scenario: Multi-node cycle

- **WHEN** sequences define `A -> EvtA` and `B -> EvtB`, and automations define `EvtA triggers B` and `EvtB triggers A`
- **THEN** the validator SHALL emit a warning with code `AUTOMATION_CYCLE` describing the cycle

#### Scenario: No cycle exists

- **WHEN** automations form a DAG with no circular paths
- **THEN** the validator SHALL NOT emit any `AUTOMATION_CYCLE` warnings

#### Scenario: No sequences defined

- **WHEN** the model has automations but no sequences
- **THEN** the cycle detection SHALL be skipped (no command→event edges can be inferred)

### Requirement: Dead event detection

The validator SHALL detect events that are not consumed by any ReadModel (via `from`) and not listened to by any Automation (via `on`), and emit an `EVENT_WITHOUT_CONSUMER` warning.

#### Scenario: Event consumed by ReadModel only

- **WHEN** an event appears in a ReadModel's `from` array but no Automation listens to it
- **THEN** the validator SHALL NOT emit an `EVENT_WITHOUT_CONSUMER` warning

#### Scenario: Event listened to by Automation only

- **WHEN** an event is referenced by an Automation's `on` field but no ReadModel consumes it
- **THEN** the validator SHALL NOT emit an `EVENT_WITHOUT_CONSUMER` warning

#### Scenario: Event with no consumers

- **WHEN** an event is not referenced by any ReadModel's `from` array AND not referenced by any Automation's `on` field
- **THEN** the validator SHALL emit a warning with code `EVENT_WITHOUT_CONSUMER`

#### Scenario: Model with no ReadModels and no Automations

- **WHEN** the model has events but zero ReadModels and zero Automations
- **THEN** the validator SHALL skip the dead event check entirely (no consumers are expected yet)

### Requirement: Empty sequence detection

The validator SHALL detect sequences with fewer than 2 steps and emit an `EMPTY_SEQUENCE` warning.

#### Scenario: Sequence with zero steps

- **WHEN** a sequence has an empty steps array
- **THEN** the validator SHALL emit a warning with code `EMPTY_SEQUENCE`

#### Scenario: Sequence with one step

- **WHEN** a sequence has exactly one step
- **THEN** the validator SHALL emit a warning with code `EMPTY_SEQUENCE` indicating a sequence needs at least 2 steps to express a temporal flow

#### Scenario: Sequence with two or more steps

- **WHEN** a sequence has 2 or more steps
- **THEN** the validator SHALL NOT emit an `EMPTY_SEQUENCE` warning
