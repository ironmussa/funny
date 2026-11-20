## ADDED Requirements

### Requirement: Remote execution is authorized for actor and runner

Funny SHALL authorize a remote-operation request against the initiating user,
thread/project access, target policy, and assigned runner before forwarding it.
The Connector SHALL verify the authorized local runtime and signed request
metadata.

#### Scenario: Authorized actor requests an assigned-runner operation

- **WHEN** a user with required project/thread access requests an allowed
  operation on its assigned runner
- **THEN** Funny forwards a signed, target-bound request only to that runner
- **AND** the Connector accepts it only after local-caller and signature validation

#### Scenario: Unauthorized actor or runner mismatch

- **WHEN** the actor lacks access, runner is not assigned, or metadata is invalid
- **THEN** Funny or the Connector rejects the request before SSH begins

### Requirement: Production targets require bound human confirmation

For a production target, the system SHALL require explicit human confirmation
before dispatch. It MUST be short-lived, single-use, and bound to actor,
thread/project, runner, target, operation, and validated arguments. An agent
MUST NOT create or reuse it.

#### Scenario: Confirmed production operation

- **WHEN** the user confirms the exact production operation in its validity window
- **THEN** Funny dispatches the bound request and the Connector can execute it

#### Scenario: Confirmation is missing, expired, or altered

- **WHEN** a production request has no confirmation, an expired/reused one, or
  metadata different from the confirmed operation
- **THEN** the system rejects it before credential lookup and SSH connection

### Requirement: Remote execution has metadata-only audit records

The system SHALL record an audit event for each authorization decision and
Connector execution attempt. It SHALL include correlation ID, actor,
thread/project, runner, target ID, operation ID, request digest, timestamps,
approval outcome, and terminal status. It MUST NOT contain credential material,
credential references, raw connection metadata, raw argv, credential envelopes,
or unredacted output.

#### Scenario: Connector operation succeeds or fails

- **WHEN** a Connector operation reaches any terminal outcome
- **THEN** Funny and the Connector record correlatable metadata-only audit events
- **AND** the result can be traced without storing the password or raw command
