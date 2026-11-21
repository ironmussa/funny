# codex-permission-approvals Specification

## Purpose

TBD - created by archiving change codex-permission-approvals. Update Purpose after archive.

## Requirements

### Requirement: Codex permission UI reflects transport capability

The system SHALL expose whether the effective Codex transport supports
structured per-tool approval and SHALL render only controls that the transport
can honor.

#### Scenario: Codex SDK reports a permission-like failure

- **WHEN** a Codex SDK thread encounters an operation that requires approval
- **THEN** the thread displays an explanatory recovery state
- **AND** it does not display an actionable per-tool approve/deny card
- **AND** it does not present the generic `Continue` action as a permission
  response

#### Scenario: Codex ACP requests a permission

- **WHEN** a Codex ACP thread emits a structured permission request
- **THEN** the thread enters `waiting` with reason `permission`
- **AND** the UI displays the exact requested tool and sanitized input with
  the decisions supported by that request

### Requirement: Structured Codex approval resumes the original request

The system SHALL resolve a structured Codex ACP request by sending the chosen
provider option to the same live request, rather than restarting the agent
with a natural-language approval message.

#### Scenario: User allows an action once

- **WHEN** the thread owner chooses `allow once` for an active request
- **THEN** the runtime selects that request's one-time allow option
- **AND** Codex continues the paused operation in the same live session
- **AND** no project-level allow rule is created

#### Scenario: User denies an action

- **WHEN** the thread owner chooses `deny` for an active request
- **THEN** the runtime selects that request's reject option
- **AND** Codex receives the denial in the same live session
- **AND** the system does not restart the agent to communicate the decision

#### Scenario: User allows an action always

- **WHEN** the thread owner chooses `allow always` and the provider offers an
  always-allow option
- **THEN** the system persists the corresponding project permission rule
- **AND** the runtime selects the request's always-allow option

#### Scenario: Always-rule persistence fails

- **WHEN** the owner chooses `allow always` but its project rule cannot be
  persisted
- **THEN** the request remains unresolved
- **AND** the system informs the owner that permanent approval was not saved
- **AND** the owner can still choose `allow once` or `deny`

### Requirement: Repeated requests remain precise

The system SHALL identify every structured permission request by an opaque
request id and its active agent run, and SHALL not reuse a resolved request to
approve a later action.

#### Scenario: Agent asks for two sequential permissions

- **WHEN** Codex requests a second permission after the owner resolved the
  first request
- **THEN** the second card shows its own tool and input
- **AND** a decision for the first request cannot resolve the second request

#### Scenario: Owner submits a stale approval

- **WHEN** an owner responds to a request that has already resolved, expired,
  or belongs to a different active run
- **THEN** the system rejects the response as stale
- **AND** the client refreshes the thread state instead of starting a new
  agent prompt

### Requirement: Lost live continuations fail safely

The system SHALL invalidate a structured pending permission when its runner or
agent process no longer owns the live continuation.

#### Scenario: Runner restarts while a permission is pending

- **WHEN** the runner restarts or the Codex ACP process exits while a request
  is pending
- **THEN** the pending request is marked expired and removed from actionable
  UI
- **AND** the thread displays a provider-recovery state explaining that the
  operation was not approved

### Requirement: Codex ACP transport is opt-in during rollout

The system SHALL allow a runner to select Codex ACP explicitly while retaining
the Codex SDK as the default transport until ACP approval support is validated.

#### Scenario: Runner selects Codex ACP

- **WHEN** a runner is configured with the Codex ACP transport and the
  required ACP binary is available
- **THEN** new Codex executions use the ACP transport and advertise structured
  permission capability

#### Scenario: Selected ACP binary is unavailable

- **WHEN** a runner selects Codex ACP but its required binary is unavailable
- **THEN** starting the thread fails with a clear provider setup error
- **AND** the system does not silently fall back to the SDK transport
