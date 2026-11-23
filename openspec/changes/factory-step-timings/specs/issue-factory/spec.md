# Spec Delta

## ADDED Requirements

### Requirement: Run step timings

A factory run as the run lists return it (the caller's queue across projects and a project's run list) SHALL carry its step timings: one entry per execution of a node of its flow, in the order they started, with the node, the visit (a loop's iteration), the attempt, the status (running, succeeded, failed, skipped, cancelled), the start time and, once it ended, the end time. The timings SHALL come from the executions the workflow engine already records for the run; reading them SHALL NOT change the run. The entries SHALL carry no step output, error text or stored data. Other answers that return a run MAY omit the timings.

#### Scenario: A run in its second review round

- **WHEN** a run's flow ran triage, implement, pull-request, ci and review, then address and review again, and the second review is running
- **THEN** the run lists return seven entries in start order, the last one `review` with status running and no end time

#### Scenario: Nothing ran yet

- **WHEN** a run is still in the queue
- **THEN** the run lists return it with no step timings
