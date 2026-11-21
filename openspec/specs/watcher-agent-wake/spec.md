# watcher-agent-wake Specification

## Purpose

TBD - created by archiving change agent-watchers. Update Purpose after archive.

## Requirements

### Requirement: Firing a watcher wakes the agent with a rendered follow-up

The system SHALL, when a watcher fires, wake the agent by enqueuing a follow-up message into the watcher's thread that resumes the existing agent session and conveys the watcher label and the elapsed delay so the agent knows what to re-check. The follow-up MUST reuse the existing thread messaging and session-resume mechanisms rather than starting an unrelated thread.

#### Scenario: Fire delivers a follow-up that resumes the session

- **WHEN** a watcher's `nextWakeAt` becomes due and the watcher fires
- **THEN** the system enqueues a follow-up that resumes the thread's existing agent session
- **AND** the follow-up states the watcher label and that the scheduled time has elapsed
- **AND** the watcher's `wakeCount` is incremented and persisted

### Requirement: A wake waits for an idle thread instead of interrupting

The system SHALL deliver a wake follow-up only when the target thread is idle. If the thread is mid-turn, the wake MUST be queued and delivered after the active turn completes, never interrupting it.

#### Scenario: Wake on an idle thread is delivered immediately

- **WHEN** a watcher fires and its thread has no active agent turn
- **THEN** the follow-up is delivered and the agent session resumes

#### Scenario: Wake on a busy thread is queued

- **WHEN** a watcher fires while its thread is mid-turn
- **THEN** the wake is queued and delivered after the current turn completes
- **AND** the in-progress turn is not interrupted

### Requirement: Agent concludes or reschedules after a wake

The system SHALL allow the woken agent to either conclude (take no further scheduling action, leaving the watcher inactive) or reschedule by calling `funny_watch` again for the same `(threadId, key)`, which re-arms the watcher for the next wake. A fired watcher MUST NOT fire again unless it is rescheduled.

#### Scenario: Agent reschedules to wait longer

- **WHEN** the agent is woken, finds the work unfinished, and calls `funny_watch` for the same key with a new delay
- **THEN** the watcher's `nextWakeAt` is set to `now + delay` and it returns to `pending`
- **AND** no second watcher is created

#### Scenario: Agent concludes by not rescheduling

- **WHEN** the agent is woken, finds the work finished, and does not call `funny_watch` again for that key
- **THEN** the fired watcher does not fire again
