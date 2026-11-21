## ADDED Requirements

### Requirement: Wake the agent when a job reaches a terminal status

The system SHALL wake the agent when a job transitions from `running` to a terminal status (`exited`, `failed`, or `killed`) by enqueuing a follow-up into the job's thread that resumes the existing agent session and conveys the job label, the verdict (status + exit code), and a tail of the job's log. The wake MUST reuse the existing thread messaging and session-resume mechanisms.

#### Scenario: Completion wakes the agent once with the verdict

- **WHEN** a job transitions from `running` to a terminal status
- **THEN** the system wakes the agent exactly once for that transition
- **AND** the follow-up states the job label, the status and exit code, and a tail of the log

#### Scenario: A still-running job does not wake the agent

- **WHEN** consecutive polls of a job all yield `running`
- **THEN** the system updates live status in the UI but does not wake the agent

### Requirement: The wake waits for an idle thread instead of interrupting

The system SHALL deliver a job-completion wake only when the target thread is idle; if a turn is in flight the wake MUST be queued and delivered after the active turn completes, never interrupting it.

#### Scenario: Wake on a busy thread is queued

- **WHEN** a job completes while its thread is mid-turn
- **THEN** the wake is queued and delivered after the current turn completes
- **AND** the in-progress turn is not interrupted

### Requirement: Optional mid-run watch

The system SHALL allow `funny_spawn` to optionally schedule a watcher (`wakeInMinutes`) so the agent is also woken mid-run to inspect progress, independently of the completion wake.

#### Scenario: Mid-run wake is scheduled alongside the job

- **WHEN** an agent calls `funny_spawn` with `wakeInMinutes`
- **THEN** the system schedules a watcher that wakes the agent after that delay even if the job is still running
- **AND** the job-completion wake still fires when the job finishes
