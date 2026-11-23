# Spec Delta

## ADDED Requirements

### Requirement: Review pipeline runs are recorded

When a commit starts the project's code-review pipeline, the system SHALL record the run as one
activity of the thread, marked automatic, that shows the stage it is in, lists the commits the
pipeline made, and ends succeeded when the run completes and failed when it is cancelled or fails.

#### Scenario: Review fixes a finding

- **WHEN** a commit triggers the review pipeline and the corrector's fix is committed
- **THEN** the thread's activity for that run lists the fix commit and ends succeeded

#### Scenario: Run cancelled

- **WHEN** a running review pipeline is cancelled
- **THEN** its activity ends failed saying it was cancelled
