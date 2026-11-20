## ADDED Requirements

### Requirement: Agent launches a durable detached process via funny_spawn

The system SHALL expose a `funny_spawn` tool to agents that launches a shell command as a funny-owned background job and returns immediately without blocking the agent's turn. The launch MUST always be detached and durable — there is no fragile mode. The tool MUST accept a command, an optional working directory, and an optional label, and MUST associate the job with the calling thread and its owning user.

#### Scenario: Spawn returns immediately and the turn can end

- **WHEN** an agent calls `funny_spawn` with a command
- **THEN** the system starts the process detached and persists a job row with `status = running`
- **AND** returns `{ jobId, logPath, pid }` without waiting for the process to finish
- **AND** the agent's turn is free to end immediately

#### Scenario: Job is scoped to its thread and user

- **WHEN** a job is spawned from a thread
- **THEN** the job records that thread's id and the thread owner's user id
- **AND** the job is only ever visible to and actionable by that user

### Requirement: A spawned process survives turn end, harness reaping, and runner restart

The system SHALL launch the process so that it is not a member of the agent's or runner's process subtree — it MUST be started in its own session (e.g. `setsid`) with its standard streams detached, so it is reparented to init and is not killed when the agent's turn ends, when the harness reaps background jobs, or when the runner process restarts.

#### Scenario: Process outlives the agent turn

- **WHEN** the agent's turn ends after a `funny_spawn`
- **THEN** the spawned process keeps running

#### Scenario: Process is not reaped with the agent subtree

- **WHEN** the harness reaps the agent/runner background subtree
- **THEN** the spawned process is unaffected because it runs in its own detached session

### Requirement: Output and exit are captured durably

The system SHALL redirect the process's stdout and stderr to a logfile and SHALL record the process's exit code to a separate exitfile when the process completes. Both files MUST persist independently of the runner process so status can be re-derived after a restart.

#### Scenario: Log is captured

- **WHEN** the spawned process writes to stdout/stderr
- **THEN** that output is written to the job's logfile, readable while the job runs and after it ends

#### Scenario: Exit code is recorded on completion

- **WHEN** the spawned process exits on its own
- **THEN** the system records its exit code in the job's exitfile

### Requirement: Restart-robust status detection distinguishes exited from killed

The system SHALL derive a job's status by polling BOTH the exitfile and process liveness, NOT by holding a parent-child handle. The exitfile presence + code yields `exited`/`failed`; an absent exitfile with a live pid yields `running`; an absent exitfile with a dead pid yields `killed` (terminated externally before it could record an exit). Status MUST be re-derivable after a runner restart from the job's `jobId`.

#### Scenario: Clean exit is detected with its code

- **WHEN** the job's exitfile exists with code 0
- **THEN** the status resolves to `exited`
- **AND** when the exitfile exists with a non-zero code, the status resolves to `failed` with that code

#### Scenario: External kill is distinguished from a clean exit

- **WHEN** a job's pid is no longer alive and no exitfile was written
- **THEN** the status resolves to `killed` (not `exited`), reflecting that it was terminated before recording an exit

#### Scenario: Status survives a runner restart

- **WHEN** the runner restarts while a job is running or after it has exited
- **THEN** the system re-derives the job's status from its exitfile and pid by `jobId`, without losing track of it

### Requirement: Jobs are polled by the shared watcher scanner

The system SHALL poll running jobs on the same heartbeat scanner used for watchers, evaluating each running job's status and persisting transitions.

#### Scenario: A running job is polled each heartbeat

- **WHEN** the heartbeat fires and a job has `status = running`
- **THEN** the system evaluates that job's status and persists any change

### Requirement: Cancelling a job stops the detached process

The system SHALL provide an ownership-checked cancel that signals the job's process group (its detached session) to terminate it, and marks the job `cancelled`. Because the process is detached, cancelling MUST target the process group, not a single child handle.

#### Scenario: Cancel terminates a running job

- **WHEN** the owning user cancels a running job
- **THEN** the system signals the job's process group and marks the job `cancelled`

#### Scenario: Cancel is ownership-checked

- **WHEN** a user attempts to cancel a job they do not own
- **THEN** the system refuses and does not signal the process

### Requirement: A running job lights the per-thread indicator

The system SHALL light the per-thread clock/background indicator when a thread has a running job, in addition to when it has a pending watcher. A job that has reached a terminal status MUST NOT light the indicator.

#### Scenario: Running job shows the indicator

- **WHEN** a thread has a job with `status = running`
- **THEN** that thread's indicator is lit

#### Scenario: Finished job clears the indicator

- **WHEN** a thread's only job reaches `exited`/`failed`/`killed`/`cancelled` and it has no pending watcher
- **THEN** that thread's indicator is not lit

### Requirement: Jobs panel and live status

The system SHALL list the current user's jobs (command, status, exit code, and a link/handle to the log) and emit per-user WebSocket events on `job:created` / `job:exited` / `job:killed` / `job:cancelled` so the UI reflects live state. Reads and cancel MUST be served such that they work even when the runner is offline (status reflects the last persisted state).

#### Scenario: Job state changes update the UI

- **WHEN** a job is created, exits, is killed, or is cancelled
- **THEN** the system emits the corresponding event to the owning user only and the UI updates without a reload
