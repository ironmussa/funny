# Spec Delta

## Purpose

Lets a user run each thread on its own remote sandbox machine from a pluggable provider (Boat first) that is provisioned on thread creation, bound exclusively to that thread, stopped when idle and resumed on demand.

## ADDED Requirements

### Requirement: Infrastructure connections

Users SHALL be able to add, test, list and delete infrastructure connections. A connection SHALL identify its provider (any provider in the registry; `boat` initially), validate its provider-specific configuration, and store its credential encrypted at rest. Credentials SHALL never be returned to the client after creation nor written to logs or audit records.

#### Scenario: Adding a valid Boat API key

- **WHEN** a user adds a Boat API key in Settings > Infrastructure
- **THEN** the system validates it against Boat, stores it encrypted and lists the connection without exposing the key

#### Scenario: Invalid key

- **WHEN** Boat rejects the key
- **THEN** the connection is not saved and the provider error is shown

### Requirement: Pluggable sandbox providers

Sandbox provisioning SHALL go through a provider-neutral contract (validate credential, capabilities, create from template, status, stop, resume, extend lifetime, destroy). Each provider SHALL declare its capabilities: whether stop/resume preserves the disk, how long a stopped disk is retained, maximum lifetime, available sizes, and environment limits. Lifecycle behavior SHALL depend only on declared capabilities, never on the provider's identity. The set of selectable providers SHALL come from a registry; providers not registered SHALL NOT be selectable. Every registered provider SHALL pass the same contract test suite.

#### Scenario: Boat selectable

- **WHEN** a user opens the thread compose options with a Boat connection configured
- **THEN** "Run in sandbox" is available with Boat as provider and the sizes Boat declares

#### Scenario: Provider without stop/resume

- **WHEN** a sandbox from a provider that declares no disk-preserving stop becomes idle
- **THEN** the sandbox is destroyed after its backup is synced, and the next request recovers the thread on a new sandbox from its branch

#### Scenario: Several providers configured

- **WHEN** a user has connections for two providers
- **THEN** they choose the provider per thread, and routing, backup and lifecycle behave the same for both

#### Scenario: Provider state normalized

- **WHEN** a provider reports a provider-specific state
- **THEN** the thread shows one of the normalized states (`provisioning`, `connecting`, `bootstrapping`, `running`, `resuming`, `stopping`, `stopped`, `failed`, `lost`)

### Requirement: Sandbox thread creation

A user with at least one infrastructure connection SHALL be able to create a thread in sandbox mode for a project with a git remote. The system SHALL provision a sandbox for that thread from the provider's funny runner template matching the server version, enroll its runner, clone the repository, create the thread branch from the selected base, and start the agent once the runner is online. Sandbox mode SHALL NOT be available for scratch threads or projects without a remote.

#### Scenario: Successful provisioning

- **WHEN** the user creates a sandbox thread with a prompt
- **THEN** the thread shows `provisioning` → `connecting` → `bootstrapping` → `running`, and the agent starts in the sandbox on branch `funny/<threadId>`

#### Scenario: Provisioning failure

- **WHEN** the provider fails to create the sandbox or the clone fails
- **THEN** the thread shows `failed` with the error and a retry action, and no agent runs on any other runner

#### Scenario: Server not publicly reachable

- **WHEN** no public server URL can be resolved
- **THEN** sandbox mode is unavailable and the UI explains that sandboxes require the hosted server

### Requirement: Thread-bound enrollment

The server SHALL issue a provisioning token per sandbox that is single-use, expires within a bounded time, and is bound to the user, project and thread. A runner registering with it SHALL be created with role `sandbox` bound to that thread, without manual approval. Reuse or expiry SHALL be rejected and audited. A resumed sandbox SHALL reconnect with its persisted credentials as the same runner.

#### Scenario: Token replay

- **WHEN** a second registration presents a consumed provisioning token
- **THEN** it is rejected and audited

#### Scenario: Resume keeps identity

- **WHEN** a stopped sandbox is resumed
- **THEN** its runner reconnects as the same runner without a new token

### Requirement: Strict thread routing

Every request for a sandbox thread (agent, follow-up, terminal, files, git) SHALL be routed only to that thread's sandbox runner. A `sandbox` runner SHALL NOT serve any other thread, project-level request or projectless work. If the sandbox runner is not connected, the system SHALL NOT fall back to any other runner.

#### Scenario: Sandbox offline

- **WHEN** a request targets a sandbox thread whose runner is disconnected
- **THEN** the request is not sent to the user's general or dedicated runner

#### Scenario: Sandbox runner reaching another thread

- **WHEN** a sandbox runner sends data or requests for a different thread or project-level resource
- **THEN** the server refuses it and audits the attempt

### Requirement: Wake on demand

When a user sends a follow-up, opens the terminal, or requests files or git for a stopped sandbox thread, the system SHALL resume the sandbox, wait for its runner to reconnect within a bounded time, and then serve the request. The thread SHALL show `resuming` meanwhile.

#### Scenario: Follow-up on stopped sandbox

- **WHEN** the user sends a follow-up to a thread whose sandbox is stopped
- **THEN** the sandbox resumes, the runner reconnects and the agent continues with the message

#### Scenario: Resume timeout

- **WHEN** the runner does not reconnect within the bound
- **THEN** the request fails with an actionable error and the message is not lost

### Requirement: Idle stop

The system SHALL stop a sandbox after a configurable idle window when no agent turn, permission prompt, running command or PTY session is active and the thread backup is not pending. When the provider supports a lifetime cap, every sandbox SHALL carry one so a lost server cannot leave it running indefinitely; a provider without a cap SHALL be stopped or destroyed by the server's sweeper on startup reconciliation.

#### Scenario: Idle sandbox stopped

- **WHEN** a sandbox thread finished its turn, has no active processes, its backup is synced and the idle window elapses
- **THEN** the sandbox is stopped and the thread shows `stopped`

#### Scenario: Activity blocks stop

- **WHEN** a PTY session or agent turn is active
- **THEN** the sandbox is not stopped

### Requirement: Recovery of a lost sandbox

If a thread's sandbox no longer exists or its disk has expired, the system SHALL provision a new sandbox for the thread, restore the code from the thread's remote branch, and continue the conversation from persisted messages. The user SHALL be told that uncommitted, ignored and local-only state was not recovered.

#### Scenario: Expired sandbox

- **WHEN** a follow-up targets a thread whose sandbox disk expired
- **THEN** a new sandbox is created from the thread branch and the agent continues with a notice about unrecovered state

### Requirement: Sandbox destroy on thread delete

Deleting a sandbox thread SHALL destroy its sandbox and remove its runner. The remote branch SHALL be kept unless the user explicitly chooses to delete it.

#### Scenario: Delete thread

- **WHEN** the user deletes a sandbox thread
- **THEN** the sandbox and its runner are removed and the remote branch remains

### Requirement: Cost guardrails

The system SHALL enforce a per-user maximum of concurrently running sandboxes across all providers and let the user pick a machine size per thread among the sizes the provider declares. Each sandbox thread SHALL display its sandbox state and accumulated running time.

#### Scenario: Limit reached

- **WHEN** the user starts or resumes a sandbox while at the running limit
- **THEN** the action is refused with an explanation listing the running sandboxes, and nothing is provisioned
