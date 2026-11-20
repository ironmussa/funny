## ADDED Requirements

### Requirement: Users can manage their own agent execution profiles

The system SHALL allow an authenticated user to create, list, update, and delete agent execution profiles owned by that user. A profile MUST include a display name, provider, optional default model, optional default permission mode, and provider-specific execution configuration.

#### Scenario: User creates a Claude work profile

- **WHEN** a user creates an agent execution profile named `Claude Work` for provider `claude` with a Claude config directory
- **THEN** the system persists the profile for that user
- **AND** the profile is returned in that user's profile list

#### Scenario: User lists profiles

- **WHEN** a user requests their agent execution profiles
- **THEN** the system returns only profiles owned by that user

#### Scenario: User deletes a profile

- **WHEN** a user deletes one of their agent execution profiles
- **THEN** the profile is no longer available for project assignment
- **AND** project bindings that referenced the deleted profile no longer resolve to that profile

### Requirement: Claude profiles isolate account state with CLAUDE_CONFIG_DIR

The system SHALL model Claude Code execution profiles with a Claude config directory and MUST translate that directory to `CLAUDE_CONFIG_DIR` when launching Claude Code. The system MUST NOT require funny to store Claude account tokens for this capability.

#### Scenario: Claude profile resolves launch environment

- **WHEN** a Claude profile has config directory `/home/user/.claude-work`
- **THEN** the resolved launch environment contains `CLAUDE_CONFIG_DIR=/home/user/.claude-work`

#### Scenario: Claude credentials remain external

- **WHEN** a user creates a Claude execution profile
- **THEN** the system stores the config directory reference
- **AND** the system does not store Claude OAuth credentials or API tokens in the profile record

### Requirement: Users can assign one profile per project

The system SHALL allow each user to assign one of their agent execution profiles as their default profile for a project. The assignment MUST be scoped to `(project, user)` and MUST NOT affect other users in the same project.

#### Scenario: User assigns work profile to a project

- **WHEN** a user assigns their `Claude Work` profile to project `client-a`
- **THEN** new threads created by that user in `client-a` resolve through `Claude Work`

#### Scenario: Collaborator has independent assignment

- **WHEN** user A assigns `Claude Work` to a project
- **AND** user B opens the same project
- **THEN** user B does not inherit user A's profile assignment
- **AND** user B may assign one of user B's own profiles independently

#### Scenario: Binding cannot reference another user's profile

- **WHEN** a user attempts to bind a project to a profile owned by another user
- **THEN** the system rejects the binding

### Requirement: Thread execution resolves the project-bound profile

The system SHALL resolve the effective profile when creating or starting a new project thread. The thread/composer request MUST NOT accept a user-selected profile id for per-thread override.

#### Scenario: Project-bound profile supplies execution defaults

- **WHEN** a user creates a new thread in a project with a bound profile
- **THEN** the thread uses the profile's provider
- **AND** the thread uses the profile's default model and permission mode when those fields are set

#### Scenario: Missing profile fields fall back to project defaults

- **WHEN** a bound profile omits default model or default permission mode
- **THEN** the thread uses the project's existing default model or default permission mode for the omitted fields

#### Scenario: No profile binding falls back to existing defaults

- **WHEN** a user creates a new thread in a project without a profile binding
- **THEN** the system uses the existing project provider, model, and permission mode defaults

#### Scenario: Thread payload cannot override profile

- **WHEN** a thread creation payload includes a profile id
- **THEN** the system ignores or rejects that profile id according to validation policy
- **AND** the effective profile is still resolved from the project binding for the authenticated user

### Requirement: Threads record resolved profile metadata without exposing secrets

The system SHALL persist non-sensitive metadata about the profile resolved for a new thread so executions are auditable. The system MUST NOT broadcast or persist sensitive profile config values in thread events intended for the client.

#### Scenario: Thread stores profile audit metadata

- **WHEN** a new thread is created from a project-bound profile
- **THEN** the thread records the resolved profile id, profile name, and provider or an equivalent non-sensitive snapshot

#### Scenario: Profile config is redacted from client events

- **WHEN** a thread update is sent to the client
- **THEN** the event does not include Claude config directory paths, account tokens, or raw profile environment values

### Requirement: UI separates profile management from project assignment

The client SHALL provide profile management in Settings and project profile assignment in Project Settings. The thread composer SHALL NOT include a profile picker.

#### Scenario: Settings manages profiles

- **WHEN** a user opens Settings
- **THEN** the user can create, edit, delete, and list their agent execution profiles

#### Scenario: Project Settings assigns profile

- **WHEN** a user opens Project Settings for a project
- **THEN** the user can choose one of their profiles as that project's agent profile

#### Scenario: Composer has no profile picker

- **WHEN** a user opens the new thread composer
- **THEN** the composer does not show a control for selecting an agent execution profile
