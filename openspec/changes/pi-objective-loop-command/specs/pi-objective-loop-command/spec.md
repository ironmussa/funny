## ADDED Requirements

### Requirement: Pi supports a funny-owned objective loop slash command

The system SHALL handle `/loop <objective>` on Pi-backed threads as a funny-owned objective loop command before dispatching the prompt to the Pi provider.

#### Scenario: Starting a Pi objective loop

- **WHEN** a user sends a prompt beginning with `/loop` in a Pi-backed thread
- **THEN** the system parses the remaining text as the objective and starts an objective loop for that thread
- **AND** the raw `/loop` command is not sent to Pi as an ordinary user prompt

#### Scenario: Missing objective

- **WHEN** a user sends `/loop` without an objective
- **THEN** the system rejects the command with a user-visible error
- **AND** no Pi turn is started

### Requirement: Objective loop delegates each iteration to normal Pi turns

The system SHALL execute each objective-loop iteration by sending a normal prompt or follow-up to the Pi provider while leaving Pi SDK internal model/tool execution delegated to Pi.

#### Scenario: First iteration

- **WHEN** a Pi objective loop starts with a valid objective
- **THEN** the system sends an initial loop prompt to Pi that includes the objective and loop status instructions

#### Scenario: Continuation iteration

- **WHEN** an iteration finishes with loop status `continue`
- **THEN** the system queues a follow-up prompt on the same thread/session asking Pi to continue pursuing the objective from current context

### Requirement: Objective loop tracks lifecycle state

The system SHALL track per-thread loop state including objective, status, iteration count, start time, latest progress summary, and stop reason.

#### Scenario: Loop state is active

- **WHEN** a Pi objective loop is running
- **THEN** the thread has active loop state with status `running` and the current iteration count

#### Scenario: Loop reaches a terminal state

- **WHEN** the loop completes, blocks, fails, is cancelled, or hits a configured limit
- **THEN** the system records a terminal status and stops scheduling further iterations

### Requirement: Objective loop uses explicit agent status

The system SHALL ask Pi to emit a machine-readable loop status after each iteration and SHALL use that status to decide whether to continue or stop.

#### Scenario: Agent reports complete

- **WHEN** Pi returns loop status `complete`
- **THEN** the system marks the objective loop complete and does not schedule another iteration

#### Scenario: Agent reports blocked

- **WHEN** Pi returns loop status `blocked`
- **THEN** the system marks the objective loop blocked and does not schedule another iteration

#### Scenario: Agent reports continue

- **WHEN** Pi returns loop status `continue`
- **THEN** the system schedules the next iteration unless a configured limit has been reached

#### Scenario: Status cannot be parsed

- **WHEN** Pi returns no parseable loop status
- **THEN** the system records the parse failure and applies the configured fallback behavior without tight-looping

### Requirement: Objective loop is bounded and cancellable

The system SHALL bound Pi objective loops with configured limits and SHALL allow user cancellation.

#### Scenario: Max iterations reached

- **WHEN** the objective loop reaches its configured max iteration count
- **THEN** the system stops the loop with a limit stop reason

#### Scenario: User cancels the loop

- **WHEN** the user stops the thread or cancels the active loop
- **THEN** the system clears active loop scheduling and does not start additional iterations

#### Scenario: Provider error

- **WHEN** a Pi turn fails during an objective-loop iteration
- **THEN** the system marks the loop failed and does not schedule additional iterations

### Requirement: Objective loop remains distinct from Pi SDK internals

The system SHALL NOT manually execute Pi tool calls or replace Pi SDK model/tool continuation as part of the objective loop.

#### Scenario: Pi emits tool events during a loop iteration

- **WHEN** Pi executes tools inside an objective-loop iteration
- **THEN** the existing Pi SDK event translation surfaces those tool events
- **AND** the objective loop controller treats the Pi turn result as the iteration boundary
