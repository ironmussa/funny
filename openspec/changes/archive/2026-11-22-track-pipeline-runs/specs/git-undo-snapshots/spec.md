# Spec Delta

## ADDED Requirements

### Requirement: Rewind checkpoints are pruned

Rewind checkpoints SHALL record when they were saved, and checkpoints older than 30 days SHALL be
removed the next time a checkpoint is saved in that repository. Checkpoints saved before they
recorded a date SHALL be kept until their thread's workspace is cleaned up.

#### Scenario: Old checkpoint

- **WHEN** a checkpoint was saved 31 days ago and a new agent turn starts in that repository
- **THEN** the old checkpoint no longer exists and rewind to that turn is not offered

#### Scenario: Recent checkpoint

- **WHEN** a checkpoint was saved yesterday
- **THEN** it can still be restored
