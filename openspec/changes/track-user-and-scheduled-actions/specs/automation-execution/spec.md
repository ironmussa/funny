# Spec Delta

## ADDED Requirements

### Requirement: Schedules are validated when saved

Creating or updating an automation SHALL refuse a schedule that is not a valid cron expression,
answering `400` with the reason, and SHALL leave the stored automation unchanged.

#### Scenario: Invalid cron on create

- **WHEN** a user creates an automation with the schedule `every morning`
- **THEN** the request is refused with `400` and no automation is created

#### Scenario: Invalid cron on update

- **WHEN** a user changes an enabled automation's schedule to `61 * * * *`
- **THEN** the request is refused with `400` and the automation keeps its previous schedule

### Requirement: An automation that will not run is reported

When the scheduler cannot schedule an enabled automation because its stored schedule is not valid,
the system SHALL record a failed activity for the automation's owner naming the automation and the
reason, at most once per automation each time it is scheduled. When a scheduled occurrence is
skipped because the automation's previous run is still running, the system SHALL record the skip for
the owner.

#### Scenario: Automation stored with a bad schedule

- **WHEN** the server starts with an enabled automation whose stored schedule does not parse
- **THEN** the owner has a failed activity saying that automation is not scheduled and why

#### Scenario: Occurrence skipped

- **WHEN** an occurrence is reached while the automation's previous run is still running
- **THEN** the owner has an activity saying the occurrence was skipped and since when the previous
  run has been running
