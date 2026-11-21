# project-runner-binding Specification

## Purpose
Defines how runners are bound to projects so that each project executes only on the runner(s) explicitly configured for it, while a user-level general runner keeps serving projectless and non-overridden work.

## Requirements

### Requirement: Runner roles

Every runner SHALL have exactly one role: `general` or `dedicated`. A user SHALL have at most one designated general runner at a time. A dedicated runner SHALL only serve projects it is explicitly assigned to.

#### Scenario: Designating the general runner

- **WHEN** a user selects a runner as their general runner in user settings
- **THEN** that runner becomes the user's general runner and any previously designated general runner loses that designation

#### Scenario: Dedicated runner without assignments

- **WHEN** a dedicated runner has no project assignments
- **THEN** it SHALL NOT receive any routed request

### Requirement: Project runner override

A project SHALL use the owner's general runner by default. A project MAY override this with one dedicated runner configured from the project's settings. Additional runners MAY be granted access to a project only from that project's settings.

#### Scenario: Project without override

- **WHEN** a request targets a project that has no runner override
- **THEN** it SHALL be routed to the owner's general runner

#### Scenario: Project with dedicated runner

- **WHEN** a request targets a project whose settings select a dedicated runner
- **THEN** it SHALL be routed only to that runner or to runners granted access in that project's settings

### Requirement: No cross-project fallback

When a project's configured runner(s) are unreachable, the system SHALL fail the request with an explicit "project runner offline" error and SHALL NOT route it to the general runner or any other runner. A dedicated runner SHALL NOT be selected as a fallback for any request outside its assignments.

#### Scenario: Dedicated runner offline

- **WHEN** a user sends a message on a thread of a project whose dedicated runner is disconnected
- **THEN** the request fails with a "project runner offline" error identifying the project, and no other runner receives it

#### Scenario: General runner offline

- **WHEN** the general runner is offline and a request targets a project without override
- **THEN** the request fails and is NOT routed to any dedicated runner

### Requirement: Project-scoped data channel authorization

Every data operation a runner performs against the server SHALL be authorized against the runner's project assignments in addition to its owner. Operations that reference a thread, project, session, queue entry, comment or tool call belonging to a project the runner is not authorized for SHALL be rejected. Listing operations SHALL return only items from authorized projects.

#### Scenario: Reading another project's thread

- **WHEN** dedicated runner X requests messages of a thread belonging to project Y, both owned by the same user, and X is not authorized for Y
- **THEN** the server rejects the operation and records an audit event

#### Scenario: Listing threads

- **WHEN** a dedicated runner lists threads
- **THEN** only threads of its authorized projects are returned

### Requirement: Projectless work placement

Scratch threads, filesystem browsing, adding a project from a local path and user-level repository operations SHALL be served only by the user's general runner.

#### Scenario: Scratch thread

- **WHEN** a user starts a scratch thread
- **THEN** it runs on the user's general runner, never on a dedicated runner

#### Scenario: No general runner

- **WHEN** a user without a reachable general runner opens the folder browser
- **THEN** the request fails with a "no general runner available" error

### Requirement: Feature parity within scope

A dedicated runner SHALL receive the same user-level settings (providers, MCP servers, skills, permission rules, agent defaults) as the general runner and SHALL support the same project features (agents, terminals, git, worktrees, in-project file browsing).

#### Scenario: Provider settings on dedicated runner

- **WHEN** a user changes provider settings
- **THEN** the change is applied on both the general runner and every dedicated runner the user owns

### Requirement: Project git credential inheritance

A project MAY define its own git hosting credential. When it does not, operations SHALL use the owner's user-level credential. Credentials SHALL be delivered per operation and SHALL NOT be persisted in runner configuration. When a dedicated runner uses an inherited user-level credential the project settings SHALL display a warning.

#### Scenario: Project credential override

- **WHEN** a project defines its own GitHub token and an agent pushes from that project
- **THEN** the push uses the project token, not the user's

#### Scenario: Inherited personal token warning

- **WHEN** a project with a dedicated runner has no credential override
- **THEN** the project settings show a warning that the runner uses the user's personal token

### Requirement: Access revocation

Removing a runner's access to a project SHALL immediately stop routing and data access for that project on that runner and terminate the runner's active agent sessions for that project. Files on the runner's disk SHALL be left in place.

#### Scenario: Revoking during a running agent

- **WHEN** a user removes runner X from project Y's settings while an agent of Y is running on X
- **THEN** the agent session is stopped, further data operations from X for Y are rejected, and the worktree on X remains on disk
