# Spec Delta

## ADDED Requirements

### Requirement: Time in the current step

A board card of a run in Triage, Implementing, PR · Proof · CI, Review or Merge SHALL say how long the run has been in its current step: since the latest execution of that step started. When the current step has no execution yet (the run waits for the step's slot, such as the repository's merge slot), the card SHALL say the run is waiting, since the previous execution ended. A run without step timings SHALL show neither.

#### Scenario: A long review

- **WHEN** a run's current step is `review` and its latest review execution started two hours ago
- **THEN** its card says it has been in review for 2 h

#### Scenario: Waiting for the merge slot

- **WHEN** a run's current step is `merge`, it has no merge execution yet, and its last execution ended 20 minutes ago
- **THEN** its card says it has been waiting for 20 min

### Requirement: Step timeline in the run panel

The run panel SHALL show the run's step executions in start order, each with its step, attempt (when more than one), status and duration (running ones up to now), and between two executions the time the run waited when it is a minute or more. A run without step timings SHALL show no timeline.

#### Scenario: A retried step and a wait

- **WHEN** a run's `ci` step ran twice (the first attempt failed) and its `merge` started 15 minutes after `review` ended
- **THEN** the timeline shows both `ci` attempts with their status and duration, and a 15 min wait before `merge`

### Requirement: Median time per stage

Each board column header for Triage, Implementing, PR · Proof · CI, Review and Merge SHALL show the median time that runs spent in that stage, over the step executions that ended in the last 7 days among the listed runs; a run's time in a stage is the sum of its executions of the stage's steps. A column with nothing to measure SHALL show no median. The steps of each stage are those of the built-in flows (`triage`; `implement`, `address`; `pull-request`, `regression-proof`, `ci`; `review`; `merge`); other steps count in no column.

#### Scenario: Review is the bottleneck

- **WHEN** three runs spent 10 min, 40 min and 2 h in review in the last 7 days
- **THEN** the Review column header shows a median of 40 min
