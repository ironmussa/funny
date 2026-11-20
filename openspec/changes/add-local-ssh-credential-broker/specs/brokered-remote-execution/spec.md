## ADDED Requirements

### Requirement: Connector is an independently distributed Funny package

Funny SHALL maintain Connector source in `packages/remote-connector` and SHALL
build it into separately installed Windows, macOS, and Linux service artifacts.
The runtime and agent-facing packages MUST NOT import or load Connector
implementation modules. Their only integration SHALL use the versioned shared
contract over the protected local IPC channel.

#### Scenario: Funny builds a Connector release

- **WHEN** a supported platform release is produced
- **THEN** it contains a standalone Connector executable and service
  installation metadata with its own version
- **AND** the runtime remains independently buildable without linking or
  embedding the Connector implementation

#### Scenario: Agent-facing code attempts an implementation import

- **WHEN** runtime or agent-facing code imports a Connector provider, storage,
  SSH, or internal service module
- **THEN** repository dependency checks reject the build or validation

### Requirement: Connector compatibility is negotiated and fails closed

The Connector SHALL report its product version, supported protocol versions,
platform, and capabilities during pairing and every health handshake. Funny and
the Connector SHALL enable enrolment and execution only after selecting a
mutually supported, non-revoked protocol and required capability set.

#### Scenario: Compatible release connects

- **WHEN** the runtime and Connector share an allowed protocol version and all
  target-required capabilities
- **THEN** they select that version before exchanging enrolment or execution
  messages

#### Scenario: Connector is incompatible or revoked

- **WHEN** no allowed protocol version exists or the Connector release is
  revoked
- **THEN** Funny reports the Connector as incompatible and disables enrolment
  and remote execution
- **AND** the runtime does not fall back to direct SSH

### Requirement: Connector installation and upgrades preserve isolation

Connector platform packages SHALL create and validate the dedicated service
identity, service-owned storage, protected IPC endpoint, and service startup
configuration. An upgrade SHALL preserve pairing and credential-provider
entries, replace the executable atomically, and restore the prior healthy
version if compatibility or post-upgrade health validation fails.

#### Scenario: Administrator installs the Connector

- **WHEN** a supported platform package is installed successfully
- **THEN** the Connector runs under its dedicated identity with protected
  storage and IPC permissions
- **AND** it reports healthy only after isolation checks pass

#### Scenario: Connector upgrade fails validation

- **WHEN** a new executable fails startup, compatibility, or isolation checks
- **THEN** the installer restores the prior healthy executable and service
  configuration
- **AND** pairing and credential-provider entries remain intact

### Requirement: Remote operations cross an isolated local Connector boundary

The system SHALL execute remote SSH operations through a separately installed
Funny Remote Connector service, not from the Funny runtime or agent process.
The Connector SHALL accept only structured requests over a protected local
channel: a Unix-domain socket on macOS/Linux or a Windows named pipe. OS and
Connector authorization MUST prevent agent identities from connecting,
inspecting Connector configuration, or accessing its credential provider.

#### Scenario: Isolated Connector is available

- **WHEN** Funny receives an authorized operation for a runner with a healthy,
  compatible Connector
- **THEN** the runtime sends the structured request to that Connector
- **AND** only status and bounded/redacted output return to Funny

#### Scenario: Connector isolation is unavailable

- **WHEN** the runtime cannot establish an authenticated local Connector
  connection or the Connector reports failed isolation validation
- **THEN** remote execution is unavailable on that runner
- **AND** the runtime MUST NOT fall back to direct SSH, a prompt, or an
  agent-accessible credential helper

#### Scenario: Untrusted local process attempts Connector access

- **WHEN** an agent process or untrusted OS identity connects to the Unix socket
  or Windows named pipe
- **THEN** the operating system and Connector reject the client before processing
  a remote-operation request

### Requirement: Remote operations are non-interactive and bounded

The Connector SHALL execute SSH through an embedded, non-interactive transport
with forwarding disabled and configured connection, authentication, execution,
output-size, and total-runtime limits. It MUST cancel the active transport when
a limit or cancellation applies.

#### Scenario: Command completes within policy limits

- **WHEN** a Connector operation completes before its limits
- **THEN** the Connector returns its exit category and bounded stdout/stderr to
  the runtime

#### Scenario: Command exceeds a policy limit

- **WHEN** connection, authentication, execution, or output exceeds target policy
- **THEN** the Connector cancels the operation and returns a non-secret timeout
  or output-limit error

### Requirement: Connector responses never contain credential material

The Connector MUST NOT expose password/private-key material through IPC
responses, stdout, stderr, process environment, exceptions, or logs. Funny
MUST treat remote output as untrusted and cap and redact it before display or
further processing.

#### Scenario: Remote output contains a protected credential value

- **WHEN** remote output contains a value recognized by the Connector's
  secret-redaction guard
- **THEN** the returned output replaces that value with a redaction marker
- **AND** no unredacted value is persisted in Connector or Funny audit logs
