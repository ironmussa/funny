## ADDED Requirements

### Requirement: A merged run closes its issue's superseded factory pull requests

When a factory run of an issue is recorded merged, the system SHALL close every other pull request
that an ended run of the same factory opened for the same issue, provided that the pull request is
open and its head is a commit the factory recorded for that run. Before closing it, the system
SHALL comment on it naming the merged pull request. After closing it, the system SHALL delete its
branch. Each close SHALL be recorded as an activity of the factory's enabler. The system SHALL NOT
close a pull request of a run that has not ended, a pull request whose head the factory did not
record, or a pull request that no run of the factory opened. A failure to close one pull request
SHALL NOT change the merged run's outcome nor stop the others from being closed. Stopping a run
SHALL NOT close its pull request.

#### Scenario: A stopped run's pull request is closed when a later run merges

- **WHEN** run A of issue #489 was stopped with its pull request #506 open, and run B of issue #489
  is recorded merged with pull request #511
- **THEN** #506 gets a comment saying it is superseded by #511, is closed, and its branch is deleted
- **AND** the enabler's activities show that #506 was closed as superseded by #511

#### Scenario: The merge happened outside the factory

- **WHEN** a person merges run B's pull request on GitHub and the factory records run B merged
- **THEN** the superseded pull requests of the issue's ended runs are closed as when the factory
  merges

#### Scenario: Somebody pushed to the old pull request

- **WHEN** an ended run's open pull request has a head commit that the factory did not record for
  that run
- **THEN** the pull request stays open and its branch stays

#### Scenario: The old run was taken over

- **WHEN** another run of the same issue is not ended (it was taken over, retried, or waits for a
  person)
- **THEN** its pull request stays open

#### Scenario: Stopping a run

- **WHEN** a member stops a run that has an open pull request, and no run of the issue has merged
- **THEN** the pull request stays open

#### Scenario: Closing fails

- **WHEN** GitHub refuses to close one superseded pull request
- **THEN** the merged run stays merged, the other superseded pull requests are still closed, and
  the failure is recorded in the activity
