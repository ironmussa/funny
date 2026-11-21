# project-sandbox-settings Specification

## Purpose
Lets each user pick, per project, which of their own sandbox provider connections new threads use, at what size, and whether the sandbox is on by default, and lets them turn it on or off when creating a thread.

## Requirements

### Requirement: Per-user project sandbox configuration

Each user SHALL be able to store at most one sandbox configuration per project they own. A configuration SHALL name one of the user's own provider connections, a machine size offered by that connection's provider, and whether new threads start with the sandbox enabled. A configuration SHALL be visible to and editable by its user only; another user of the same project SHALL neither see nor use it.

#### Scenario: Save a configuration

- **WHEN** the project owner saves a configuration naming one of their connections and a size that connection's provider offers
- **THEN** the configuration is stored and returned with the connection, size and default flag

#### Scenario: Size omitted

- **WHEN** a configuration is saved without a size
- **THEN** the provider's default size is stored

#### Scenario: Another user's connection

- **WHEN** a configuration names a connection that does not belong to the caller
- **THEN** the request is refused as not found and nothing is stored

#### Scenario: Unknown size

- **WHEN** a configuration names a size the connection's provider does not offer
- **THEN** the request is refused as invalid and nothing is stored

#### Scenario: Project not owned

- **WHEN** a user reads or saves the configuration of a project they do not own
- **THEN** the request is refused as not found

#### Scenario: Clear a configuration

- **WHEN** the user clears the project's configuration
- **THEN** it is removed and the project has no sandbox for that user

### Requirement: Configuration follows its connection

Removing a provider connection SHALL remove every project sandbox configuration that uses it.

#### Scenario: Connection removed

- **WHEN** a user removes a connection that two of their projects use
- **THEN** both projects have no sandbox configured for that user

### Requirement: Sandbox thread creation from the project configuration

Creating a sandbox thread without naming a connection SHALL use the caller's sandbox configuration for the thread's project: its connection and its size. The server SHALL resolve the connection; it SHALL refuse the creation when the caller has no configuration for the project. A creation that names a connection explicitly SHALL keep working and SHALL only accept the caller's own connections.

#### Scenario: Thread uses the project sandbox

- **WHEN** the user creates a sandbox thread in a project whose configuration names their InstaBox connection with size `large`
- **THEN** the thread's sandbox is provisioned on that InstaBox connection at size `large`

#### Scenario: No configuration

- **WHEN** the user creates a sandbox thread without a connection in a project they have not configured
- **THEN** the creation is refused with a conflict explaining that the project has no sandbox configured, and no thread is created

### Requirement: Composer sandbox toggle

When creating a thread in a project, the composer SHALL offer a sandbox on/off toggle if and only if the current user has a sandbox configured for that project. The toggle SHALL start at the configuration's default. When the toggle is on, the thread SHALL be created as a sandbox thread from the project configuration; when it is off, it SHALL be created with the runtime chosen in the runtime selector. The runtime selector SHALL NOT list provider connections. Scratch threads SHALL never offer the toggle.

#### Scenario: Default on

- **WHEN** the user opens the composer in a project whose configuration is enabled by default
- **THEN** the sandbox toggle is shown on, labeled with the connection's name

#### Scenario: Turned off for one thread

- **WHEN** the user turns the toggle off and sends the prompt
- **THEN** the thread is created with the selected runtime and no sandbox

#### Scenario: Not configured

- **WHEN** the user opens the composer in a project with no sandbox configured for them
- **THEN** no sandbox toggle is shown and the runtime selector offers no sandbox entries

#### Scenario: Scratch thread

- **WHEN** the user composes a scratch thread
- **THEN** no sandbox toggle is shown

### Requirement: Project settings sandbox section

The project settings SHALL include a Sandbox section where the owner picks one of their connections or none, the size among the provider's sizes, and the default on/off state. When the user has no connections, the section SHALL point to Settings > Sandboxes to add one.

#### Scenario: Pick a connection

- **WHEN** the owner selects an InstaBox connection in the project's Sandbox section
- **THEN** the configuration is saved with the provider's default size and the size picker lists that provider's sizes

#### Scenario: No connections yet

- **WHEN** the user has no provider connections
- **THEN** the Sandbox section explains that a connection is needed and links to Settings > Sandboxes
