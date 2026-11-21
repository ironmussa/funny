## ADDED Requirements

### Requirement: Agent schedules a deferred wake via the funny_watch tool

The system SHALL expose a `funny_watch` tool to agents that schedules a durable deferred wake ("snooze") and returns immediately without blocking the agent's turn. The tool MUST accept at minimum a stable `key`, a `delay`, and a human-readable `label`, and MUST associate the watcher with the calling thread and its owning user. The system SHALL NOT run any check command or evaluate any condition itself — the watcher records only when to wake the thread.

#### Scenario: Agent schedules a wake and releases its turn

- **WHEN** an agent calls `funny_watch` with a key, a delay, and a label
- **THEN** the system persists a watcher with `status = pending` and `nextWakeAt = now + delay`
- **AND** returns the watcher id to the agent without waiting
- **AND** the agent's turn is free to end immediately

#### Scenario: Watcher is scoped to its thread and user

- **WHEN** a watcher is scheduled from a thread
- **THEN** the watcher records that thread's id and the thread owner's user id
- **AND** the watcher is only ever visible to and actionable by that user

#### Scenario: Invalid scheduling is rejected

- **WHEN** an agent calls `funny_watch` with a missing key/label, a delay below the minimum clamp, or against a thread the caller does not own
- **THEN** the system rejects the call with an error and creates no watcher

### Requirement: funny_watch is the sole creation path for a watcher

The system SHALL create a watcher only as the result of a `funny_watch` tool call. No watcher SHALL be created from inspecting an agent's message text or from any inference. Any mechanism that detects an unscheduled deferred-check intent MUST act only by re-prompting the agent, never by creating a watcher directly.

#### Scenario: Only the tool creates a watcher

- **WHEN** any part of the system other than the `funny_watch` handler wishes to ensure a check is scheduled
- **THEN** it MUST cause the agent to call `funny_watch` rather than insert a watcher itself

### Requirement: Create and reschedule are one idempotent operation

The system SHALL treat scheduling and rescheduling as a single idempotent operation keyed by `(threadId, key)`. When `funny_watch` is called for a `(threadId, key)` that already has a live watcher, the system MUST re-arm that watcher's `nextWakeAt` rather than create a second one.

#### Scenario: Re-arming an existing watcher

- **WHEN** `funny_watch` is called with a `(threadId, key)` that already has a `pending` or recently `fired` watcher
- **THEN** the system sets that watcher's `nextWakeAt = now + delay` and preserves its identity and `wakeCount`
- **AND** does not create a second watcher

#### Scenario: First call for a new key creates one

- **WHEN** `funny_watch` is called with a `(threadId, key)` that has no live watcher
- **THEN** the system creates exactly one watcher

### Requirement: Durable due-time scanner engine

The system SHALL drive watchers with a single heartbeat scanner that queries the database for `status = pending` watchers whose `nextWakeAt` is due and fires them. The database row MUST be the source of truth; the in-memory timer MUST be a disposable projection holding no durable state.

#### Scenario: Due watchers fire on a heartbeat

- **WHEN** the heartbeat fires and one or more pending watchers have `nextWakeAt <= now`
- **THEN** the system fires each due watcher
- **AND** does not fire watchers whose `nextWakeAt` is still in the future

#### Scenario: Catch-up after the runner was unavailable

- **WHEN** the runner was down past one or more `nextWakeAt` times and then restarts
- **THEN** the overdue watchers are detected on the first heartbeat and fired immediately, even if late

### Requirement: Watchers are rehydrated on runner startup

The system SHALL, on runner startup, load all `status = pending` watchers from the database and resume scanning them. No watcher state SHALL depend on an in-memory timer surviving a process restart, and no client action (such as a browser refresh) SHALL be required to resume one.

#### Scenario: Pending watchers survive a runner restart

- **WHEN** the runner process restarts while a watcher is `pending`
- **THEN** the watcher is reloaded from the database and continues to be scanned

### Requirement: Lifecycle limits and cleanup

The system SHALL stop a watcher when it is concluded, cancelled, exceeds its `maxWakes`, or passes its `deadline`, and SHALL remove a thread's watchers when that thread is deleted. A stopped watcher MUST NOT fire again.

#### Scenario: Deadline expires a watcher

- **WHEN** a watcher's `deadline` passes before it is concluded
- **THEN** the system stops it, marks it `expired`, and surfaces the timeout in the UI

#### Scenario: Wake cap expires a watcher

- **WHEN** firing a watcher would exceed its `maxWakes`
- **THEN** the system stops it, marks it `expired`, and reports the cap rather than waking again

#### Scenario: Deleting a thread removes its watchers

- **WHEN** a thread with watchers is deleted
- **THEN** all of that thread's watchers stop and are removed

### Requirement: Global Watchers panel with live status

The system SHALL present a single cross-thread Watchers panel in the client that lists the current user's watchers with label, status, a countdown to the next wake, and wake count, and SHALL provide a control to cancel a watcher. All interactive elements MUST carry `data-testid` attributes. The system SHALL emit a per-user WebSocket event whenever a watcher is created, fired, rescheduled, completed, or cancelled so the panel reflects live state.

#### Scenario: User sees and cancels a pending watcher

- **WHEN** a watcher is pending and the user views the Watchers panel
- **THEN** the panel shows its label, status, time until the next wake, and wake count
- **AND** the user can cancel it, after which it stops and is marked `cancelled`

#### Scenario: Watcher state changes update the panel live

- **WHEN** a watcher is created, fires, is rescheduled, completes, or is cancelled
- **THEN** the system emits the corresponding event to the owning user only and the panel updates without a reload
