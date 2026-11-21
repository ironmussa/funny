# automation-execution Specification

## Purpose
Defines when and where automation runs execute, how each run is recorded and completed, and the guarantees that keep runs inside the automation owner's own runner.

## Requirements

### Requirement: Enabled automations run on their schedule

The system SHALL execute each enabled automation at every occurrence of its cron schedule while the server is running. Disabled automations SHALL NOT run on a schedule. Creating, updating, enabling, disabling, or deleting an automation SHALL take effect for subsequent occurrences without a server restart. Occurrences missed while the server was down SHALL NOT be replayed.

#### Scenario: Scheduled run fires

- **WHEN** an enabled automation's schedule occurrence is reached
- **THEN** a new run is started for that automation and its `lastRunAt` is set to the start time

#### Scenario: Disabled automation does not fire

- **WHEN** an automation is disabled and its schedule occurrence is reached
- **THEN** no run is started

#### Scenario: Schedule change applies immediately

- **WHEN** a user changes an automation's schedule
- **THEN** subsequent runs follow the new schedule and `nextRunAt` reflects the next occurrence of the new schedule

#### Scenario: Deleted automation stops firing

- **WHEN** an automation is deleted
- **THEN** no further runs are started for it

#### Scenario: No catch-up after downtime

- **WHEN** the server restarts after missing one or more occurrences
- **THEN** missed occurrences are not executed and the next run happens at the next future occurrence

### Requirement: Runs execute only on the owner's runner

Every run SHALL execute on a runner that belongs to the automation's owner and is allowed to serve the automation's project, using the same project-to-runner rules as interactive threads. The system MUST NOT execute a run on another user's runner. The run SHALL act with the owner's identity.

#### Scenario: Run dispatched to owner's runner

- **WHEN** a run starts for an automation owned by user U on project P
- **THEN** the run's thread is created on a runner of U that may serve P, and the thread belongs to U

#### Scenario: Project pinned to a dedicated runner

- **WHEN** the automation's project is pinned to a dedicated runner of the owner
- **THEN** the run executes only on that runner or an explicitly granted one

#### Scenario: Owner's runner is offline

- **WHEN** a run starts and no eligible runner of the owner is available
- **THEN** no other user's runner is used, the run is recorded as failed with a reason stating the runner was unavailable, and it appears in the owner's run history

### Requirement: Runs are read-only threads

Each run SHALL create a new thread in the automation's project with source `automation`, local mode, and the automation's prompt, provider, model, and permission mode. The agent in that thread MUST NOT be able to use file-editing, file-writing, notebook-editing, or shell tools.

#### Scenario: Run thread is restricted

- **WHEN** a run's agent attempts to edit or write a file or run a shell command
- **THEN** the tool is unavailable to the agent

#### Scenario: Run thread is visible to its owner

- **WHEN** a run starts
- **THEN** its thread appears in the owner's project with source `automation`, and the owner is notified that a run started

### Requirement: Runs are completed and summarized

When a run's thread reaches a terminal status (completed, failed, stopped, or interrupted), the system SHALL record the run's final status, its completion time, and a summary taken from the agent's last reply. A completed run SHALL be marked as having findings and stay pending review in the owner's inbox. A run that did not complete SHALL be marked failed and SHALL remain visible in the run history (it is not silently dismissed). The owner SHALL be notified when a run finishes. Completion SHALL NOT depend on polling or on the owner having a browser open.

#### Scenario: Run completes

- **WHEN** a run's thread reaches status completed
- **THEN** the run is marked completed with findings, a summary from the agent's last reply, and its completion time, and it is pending review in the inbox

#### Scenario: Run does not complete

- **WHEN** a run's thread ends with status failed, stopped, or interrupted
- **THEN** the run is marked failed with its completion time and remains visible in the automation's run history

#### Scenario: Owner is offline when the run finishes

- **WHEN** a run's thread finishes while the owner has no browser connected
- **THEN** the run is still recorded as finished and is visible the next time the owner opens the inbox

### Requirement: Run history is bounded

For each automation the system SHALL keep at most `maxRunHistory` completed runs visible, archiving the threads of older runs.

#### Scenario: History exceeds the limit

- **WHEN** a run completes and the automation now has more completed runs than `maxRunHistory`
- **THEN** the threads of the oldest runs beyond the limit are archived

### Requirement: Manual trigger

A user who may run an automation SHALL be able to trigger a run immediately, independent of its schedule and of whether it is enabled. The manual run SHALL follow the same runner, restriction, and recording rules as a scheduled run. Triggering an automation the caller cannot access SHALL return `404`.

#### Scenario: Owner triggers a run

- **WHEN** the automation's owner triggers it manually
- **THEN** a run starts immediately on the owner's runner and the response confirms it started

#### Scenario: Another user triggers it

- **WHEN** a user without access to the automation triggers it
- **THEN** the response is `404` and no run starts

### Requirement: Existing automations require re-enabling

When this capability is first deployed, every automation enabled at that moment SHALL be disabled once, so that no automation starts running without its owner deliberately re-enabling it. Automations created or enabled after the rollout are unaffected.

#### Scenario: Rollout

- **WHEN** the server first starts with this capability and an automation is enabled
- **THEN** the automation becomes disabled and does not run until its owner enables it again

#### Scenario: Re-enabled after rollout

- **WHEN** an owner re-enables an automation after the rollout
- **THEN** it runs on its schedule and stays enabled across later server restarts
