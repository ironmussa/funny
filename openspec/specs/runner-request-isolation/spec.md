# runner-request-isolation Specification

## Purpose
Guarantees that every request and terminal message the central server sends to a
runner targets a runner owned by, and in scope for, the identity signed into that
message, so one user's work never reaches another user's runner.

## Requirements

### Requirement: Runner requests are bound to the signed identity's own runner

Every request and terminal message the server sends to a runner MUST target a
runner owned by the user whose identity is signed into that message. The signed
identity MUST be the same identity that was used to select the runner. When no
runner owned by that user is reachable and in scope, the server MUST fail the
operation and MUST NOT send it to a runner owned by any other user.

#### Scenario: Request reaches the actor's own runner

- **WHEN** an authenticated user triggers an operation that is forwarded to a runner
- **AND** that user has a reachable runner in scope for the target
- **THEN** the server sends the request to that runner
- **AND** the forwarded identity signed into the request is that user's identity

#### Scenario: Another user's online runner is never used

- **WHEN** an authenticated user triggers a forwarded operation
- **AND** none of that user's runners are reachable, but another user's runner is online
- **THEN** the server fails the operation with a runner-unavailable error
- **AND** no request is sent to the other user's runner

#### Scenario: Terminal traffic follows the same rule

- **WHEN** a user opens or writes to a terminal for a project
- **THEN** the terminal message is dispatched only to a runner owned by that user
- **AND** the terminal is refused when that user's runner is unavailable

### Requirement: Runner selection respects the project runner binding

When a request targets a project, the selected runner MUST be permitted to serve
that project under the project runner binding. A project pinned to a dedicated
runner MUST route only to that runner or its explicit grants; when they are
offline the server MUST fail with the project-runner-offline condition and MUST
NOT fall back to another runner. Projectless work MUST route only to a general
runner.

#### Scenario: Pinned project with its dedicated runner offline

- **WHEN** a user's request targets a project pinned to a dedicated runner
- **AND** that dedicated runner is offline while the user's general runner is online
- **THEN** the server fails the request with the project-runner-offline condition
- **AND** no request is sent to the general runner

#### Scenario: Projectless work never reaches a dedicated runner

- **WHEN** a user starts projectless work (for example a browser session)
- **AND** the user's only reachable runner is a dedicated runner
- **THEN** the server fails the operation instead of using the dedicated runner

### Requirement: Runner resolution requires an authenticated user

Selecting a runner for a user-initiated request MUST require the authenticated
user's identity. There MUST be no resolution path that, lacking a user, returns
an arbitrary runner of a project. The only request that MAY be routed without an
authenticated user is the unauthenticated third-party OAuth callback, and that
path MUST NOT be usable to send any other request.

#### Scenario: OAuth callback is the only userless route

- **WHEN** an external OAuth provider redirects to the MCP OAuth callback without a session
- **THEN** the server may route the callback to a connected runner
- **AND** no other request path can obtain a runner without an authenticated user

#### Scenario: Missing user is rejected, not widened

- **WHEN** a forwarded request arrives without an authenticated user (and is not the OAuth callback)
- **THEN** the server rejects it as unauthorized
- **AND** no runner is selected or contacted

### Requirement: System-initiated runner requests act as the resource owner

Requests the server sends to a runner on behalf of trusted system components (the
standalone scheduler, project runner settings changes) MUST sign the identity of
the owner of the thread or project they act on. An identity supplied in the
system request body MUST NOT override that owner; a mismatch MUST be refused
without contacting any runner.

#### Scenario: Scheduler dispatch for a thread signs the thread owner

- **WHEN** the scheduler dispatches work for a thread
- **THEN** the server selects a runner of that thread's owner and signs the owner's identity

#### Scenario: Scheduler dispatch with a mismatching user is refused

- **WHEN** the scheduler dispatches work for a thread with a `userId` that is not the thread's owner
- **THEN** the server refuses the dispatch
- **AND** no runner is contacted

#### Scenario: Stopping sessions after a runner binding change

- **WHEN** a project owner changes the project's dedicated runner and the server stops sessions on revoked runners
- **THEN** each stop request is sent only to runners owned by that project owner
- **AND** it is signed with the project owner's identity
