# Spec Delta

## Purpose

Guarantees that background work an agent starts (subagents, background shell commands) keeps the same tool permissions and funny tool servers as the main turn, and that the agent process still exits once all work is finished.

## ADDED Requirements

### Requirement: Background tasks keep tool access after the main turn ends

While any background task started by an agent session is still running, tool calls made by that task MUST be evaluated by the same permission policy as tool calls in the main turn (including saved allow/deny rules and the thread's permission mode), and funny-provided tool servers MUST remain reachable. Tool calls MUST NOT be auto-denied merely because the main turn has produced its final result.

#### Scenario: Background subagent runs a shell command after the turn ends

- **WHEN** an agent launches a background subagent, the main turn finishes, and the subagent then runs a shell command allowed by the thread's permission mode
- **THEN** the command executes and its output is returned to the subagent

#### Scenario: Agent messages a running background subagent

- **WHEN** a later turn sends a message to a still-running background subagent
- **THEN** the message is delivered instead of being denied

### Requirement: Session ends when all work is finished

The agent session MUST end once the main turn and every non-ambient background task have finished. Ambient tasks (long-lived watchers that never end on their own) MUST NOT keep the session alive. Steerable sessions keep their existing behavior of staying open until explicitly stopped.

#### Scenario: No background work

- **WHEN** a turn finishes and no background task was started
- **THEN** the session ends immediately after the result, as before

#### Scenario: Last background task finishes

- **WHEN** the final background task completes and the follow-up turn produces its result
- **THEN** the session ends and the agent process exits

#### Scenario: Only ambient tasks remain

- **WHEN** a turn finishes and the only running tasks are ambient watchers
- **THEN** the session ends
