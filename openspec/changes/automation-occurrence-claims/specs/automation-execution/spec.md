# Spec Delta

## ADDED Requirements

### Requirement: A scheduled occurrence starts at most one run

The system SHALL start at most one run for each scheduled occurrence of an automation,
however many server processes are running. A server process SHALL start the run of an
occurrence only after it has recorded, in the database and in one conditional write, that
the automation's next occurrence is the one after it; a process whose write changes nothing
SHALL start no run and SHALL record no skip. A manual run SHALL NOT take or wait for an
occurrence.

#### Scenario: Two server processes reach the same occurrence

- **WHEN** two server processes reach the same occurrence of an enabled automation
- **THEN** exactly one run is started, and the automation's next run time is the following occurrence

#### Scenario: A process that reaches the occurrence late

- **WHEN** a server process reaches an occurrence that another process already took
- **THEN** it starts no run and records no skipped occurrence

#### Scenario: A manual run next to a scheduled one

- **WHEN** the owner triggers an automation manually just before its scheduled occurrence
- **THEN** the manual run starts, and the scheduled occurrence is still taken and handled by the overlap rule

#### Scenario: An automation whose next run time was never recorded

- **WHEN** an occurrence is reached for an automation that has no next run time stored
- **THEN** one process takes the occurrence and starts the run
