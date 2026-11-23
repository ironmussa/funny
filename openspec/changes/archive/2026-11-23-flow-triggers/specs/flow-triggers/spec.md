# Spec Delta

## Purpose

Defines what may start a factory flow (a trigger), the inputs a trigger supplies to the
flow, and how runs that have no GitHub issue behave. It lets one flow executor serve work
that starts from an issue, a schedule or a person, instead of one mechanism per source.

## ADDED Requirements

### Requirement: Every run records the trigger that started it

A factory run SHALL record the kind of trigger that started it — `manual` (an issue sent to
the queue), `label` (a labelled issue admitted in automatic mode), `schedule` or `run_now` —
and the input values that trigger supplied. Resuming, retrying or taking over a run SHALL use
the recorded inputs, not the trigger's current definition. A run started by an issue SHALL
keep its issue number; a run started by `schedule` or `run_now` SHALL have no issue.

#### Scenario: A sent issue keeps its trigger and issue

- **WHEN** a member sends issue 12 to a factory
- **THEN** the run records the trigger `manual` and the issue number 12

#### Scenario: A scheduled run has no issue

- **WHEN** a schedule trigger starts a run
- **THEN** the run records the trigger `schedule`, the trigger's id and its input values, and no issue number

#### Scenario: Editing a trigger does not change a run in progress

- **WHEN** a schedule trigger's inputs are edited while one of its runs is in progress, and that run is resumed after a restart
- **THEN** the run continues with the inputs it recorded when it started

### Requirement: A flow starts only when its required inputs are supplied

The system SHALL start a flow for a trigger only when every input the flow declares as
required is supplied, either by the factory (the repository, the run's branch, the base
branch, the factory id) or by the trigger. A flow that requires an issue input SHALL be
startable only by an issue trigger. The check SHALL run when a schedule trigger is saved,
when a member starts a flow without an issue, and again when the run starts; a failed check
SHALL name the missing inputs and SHALL start no thread.

#### Scenario: An issue flow is refused for a schedule

- **WHEN** a member saves a schedule trigger whose flow requires `issue_number`
- **THEN** the save is refused with a message naming `issue_number`

#### Scenario: A flow with only factory inputs can be scheduled

- **WHEN** a member saves a schedule trigger whose flow requires no input beyond those the factory supplies
- **THEN** the trigger is saved

#### Scenario: A flow that gained a required input fails at start

- **WHEN** a saved schedule trigger's occurrence arrives after the flow on the default branch gained a required input the trigger does not supply
- **THEN** the run is marked failed with a message naming the input, and no thread is started

### Requirement: An issueless run cannot use the steps that judge a change against an issue

A run without an issue SHALL NOT execute `triage`, `review`, `regression_proof` or `merge`
steps. A flow that contains any of them SHALL be refused for a `schedule` or `run_now`
trigger with a message naming the step. An issueless run MAY open a pull request; the system
SHALL NOT merge that pull request by itself.

#### Scenario: A flow with a merge step is refused

- **WHEN** a member saves a schedule trigger for the flow `issue-to-merge`
- **THEN** the save is refused with a message naming the steps that need an issue

#### Scenario: An issueless run opens a pull request and stops there

- **WHEN** an issueless run's flow commits, pushes and opens a pull request
- **THEN** the run records the pull request and waits for a person, as a run of a flow without a `merge` step does

### Requirement: Schedule triggers start a flow at each occurrence

A factory SHALL hold any number of schedule triggers, each with a name, a cron schedule, a
flow name, input values and an enabled flag. Saving one SHALL need `steer` on the project
and SHALL refuse a schedule that cannot be run, with the reason. At each occurrence of an
enabled trigger of an enabled factory, the system SHALL start one run of the trigger's flow
as the factory's enabler, on the enabler's runtime, under the factory's concurrency cap. A
run that cannot be admitted because the cap is reached SHALL wait in the factory's queue in
the order it arrived.

#### Scenario: An occurrence starts a run

- **WHEN** an enabled schedule trigger's time arrives and the factory is enabled and under its cap
- **THEN** one run of the trigger's flow starts with the trigger's input values

#### Scenario: A paused factory runs no schedule

- **WHEN** a schedule trigger's time arrives while its factory is paused
- **THEN** no run is created for that occurrence

#### Scenario: A disabled trigger does not run

- **WHEN** the time of a schedule trigger that is not enabled arrives
- **THEN** no run is created

#### Scenario: An invalid schedule is refused

- **WHEN** a member saves a schedule trigger with a pattern that is not a valid schedule
- **THEN** the save is refused with a message saying why

#### Scenario: A member without steer cannot save a trigger

- **WHEN** a member whose role lacks `steer` saves a schedule trigger
- **THEN** the save is refused

### Requirement: A schedule trigger has one run in flight at a time

The system SHALL NOT start a run for a schedule trigger while a run of the same trigger has
not reached a terminal state or a state that waits for a person. The skipped occurrence
SHALL be recorded as an activity of the enabler saying which trigger did not run and why.
A missed occurrence (the server was down) SHALL NOT be run later.

#### Scenario: An occurrence is skipped while the previous run works

- **WHEN** a schedule trigger's time arrives and its previous run is still working
- **THEN** no run is created, and an activity records that the occurrence was skipped

#### Scenario: A run waiting for a person does not block the schedule

- **WHEN** a schedule trigger's time arrives and its previous run opened a pull request and waits for a person
- **THEN** a new run starts

### Requirement: A member starts a flow without an issue

A member with `steer` SHALL be able to start one run of a flow from the factory view by
choosing the flow and typing a value for each input the flow declares and the factory does
not supply. The system SHALL refuse the start when the factory cannot work (paused, runner
offline, GitHub App missing), with the same reasons as sending an issue.

#### Scenario: Starting a flow with typed inputs

- **WHEN** a member chooses a flow that declares the input `scope` and types a value for it
- **THEN** a run starts with the trigger `run_now` and that value for `scope`

#### Scenario: A required input left empty

- **WHEN** a member starts a flow and leaves a required input empty
- **THEN** the start is refused with a message naming the input

#### Scenario: The factory is paused

- **WHEN** a member starts a flow on a paused factory
- **THEN** the start is refused with the message a sent issue gets on a paused factory

### Requirement: An issueless run ends as done when its flow finishes without a pull request

A run without an issue whose flow completes without opening a pull request SHALL end in the
terminal state `done`. A run with an issue SHALL keep ending as it does today.

#### Scenario: A scheduled audit finishes

- **WHEN** a scheduled run's flow runs an agent and a notification and completes
- **THEN** the run's state is `done`

#### Scenario: An issue run that changes nothing is unchanged

- **WHEN** a run started by an issue completes without a pull request
- **THEN** the run's state is `no_change`

### Requirement: Trigger input values are the trigger author's text

Input values of a `schedule` or `run_now` trigger SHALL be stored as written by the member
who saved or started it, SHALL be shown to every member who can see the factory's settings,
and SHALL NOT hold secrets: the settings SHALL say so, and a value SHALL be refused when
its input name is one the project's secret-name rules refuse. Deleting a factory SHALL
delete its triggers.

#### Scenario: A trigger named like a credential is refused

- **WHEN** a member saves a trigger with an input named `GH_TOKEN`
- **THEN** the save is refused

### Requirement: Triggers stop with their factory

When a factory turns itself off because its enabler lost access to the project, its schedule
triggers SHALL stop producing runs until another member enables the factory in their own
name; the triggers' definitions SHALL be kept.

#### Scenario: The enabler loses access

- **WHEN** a factory's enabler is removed from the project
- **THEN** the factory's schedule triggers start no run, and they are still listed when another member enables the factory
