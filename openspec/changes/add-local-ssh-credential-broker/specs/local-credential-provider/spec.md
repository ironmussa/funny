## ADDED Requirements

### Requirement: Credential lifecycle is Connector-owned and opaque to Funny

The Connector SHALL receive an end-to-end encrypted credential-enrolment
envelope, persist the credential locally, and resolve its opaque reference only
through a Connector-owned platform-native provider. Windows SHALL use isolated
Credential Manager/DPAPI integration, macOS an isolated Keychain integration,
and Linux an isolated Secret Service-compatible integration, unless an approved
alternative provider is configured. Funny, its database, runtime, agents,
standard protocol payloads, and UI MUST NOT receive or persist the resolved
username/password value.

#### Scenario: Connector resolves a target credential

- **WHEN** host verification and operation policy succeed for a target with a
  valid local credential reference
- **THEN** only the Connector resolves the credential in memory and uses it for
  that SSH authentication attempt
- **AND** the runtime receives no credential value

#### Scenario: Provider is unavailable or locked

- **WHEN** the provider cannot resolve a credential
- **THEN** the Connector fails with a generic credential-unavailable status
- **AND** it does not prompt an agent or user for a password

#### Scenario: Native provider cannot serve the Connector identity

- **WHEN** a native credential store cannot be accessed non-interactively by
  the isolated Connector identity
- **THEN** the Connector disables targets using that provider and reports a
  generic configuration or credential-unavailable status
- **AND** it MUST NOT fall back to an agent login session or password prompt

### Requirement: Credential providers satisfy a no-leak interface

A provider MUST NOT reveal a secret through a command line, environment,
stdout/stderr, IPC response, or agent-readable file. Providers that cannot meet
this constraint MUST be rejected during Connector configuration validation.

#### Scenario: Unsafe provider configuration is installed

- **WHEN** Connector startup validates a provider that would expose a password
  to an agent-accessible process, command line, environment, or file
- **THEN** the Connector refuses to enable targets that use it
- **AND** it records only a non-secret configuration error

### Requirement: Credential lifetime is limited to a request

The Connector SHALL retain resolved password material only for the minimum
duration needed to authenticate one operation and SHALL release references after
completion, failure, or cancellation.

#### Scenario: Operation finishes or is cancelled

- **WHEN** an SSH operation exits, is rejected after resolution, or is cancelled
- **THEN** the Connector releases the provider result before its next request
