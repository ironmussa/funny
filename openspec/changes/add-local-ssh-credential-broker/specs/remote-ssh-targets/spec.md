## ADDED Requirements

### Requirement: Connector-managed SSH targets use fixed non-secret metadata

The system SHALL identify every remote SSH destination by a human-managed,
Funny-signed target ID. The Connector SHALL cache target configuration in
service-owned storage. A target SHALL contain fixed connection metadata, an
opaque credential reference, environment, limits, pinned host-key fingerprints,
and named operation policy. Funny agent input and remote-operation requests MUST
NOT accept a password, private key, hostname, port, SSH option, or credential
reference.

#### Scenario: Request references a configured target

- **WHEN** an authorized request names a configured target ID
- **THEN** the Connector resolves connection metadata solely from its signed
  cached target configuration
- **AND** the request cannot override host, port, user, or credential

#### Scenario: Target does not exist or is disabled

- **WHEN** a request names an unknown or disabled target ID
- **THEN** the system rejects it before credential lookup or connection

### Requirement: SSH server identity is pinned and verified

The Connector SHALL verify the remote server against configured host-key
fingerprints on every connection. It MUST use strict verification and MUST NOT
learn, replace, or accept a host key interactively.

#### Scenario: Presented host key matches target policy

- **WHEN** the remote server presents a configured host key
- **THEN** the Connector permits authentication and operation execution

#### Scenario: Presented host key is absent or changed

- **WHEN** the remote server presents an unconfigured or mismatched host key
- **THEN** the Connector terminates the connection without supplying credentials
- **AND** it records a non-secret host-verification failure

### Requirement: Remote execution is restricted to named operations

Each target SHALL expose finite human-managed operation IDs. An operation SHALL
have a fixed remote command template and typed allowlisted arguments. The
Connector MUST NOT invoke a local shell or interpolate caller data into shell
syntax. For SSH servers that expose only a command-string `exec` request, the
Connector MUST serialize the validated executable and every argument as
independently POSIX-single-quoted tokens before sending that string. The
Connector MUST reject unrecognized operations or invalid arguments.

#### Scenario: Allowed operation has valid arguments

- **WHEN** an authorized request supplies a configured operation with valid arguments
- **THEN** the Connector executes only the resulting fixed remote command
- **AND** whitespace and shell metacharacters in each validated token remain
  literal data in that token

#### Scenario: Arbitrary command is requested

- **WHEN** a request supplies an unconfigured operation, extra argument, raw
  command string, or an argument that fails validation
- **THEN** the Connector rejects it and does not start SSH
