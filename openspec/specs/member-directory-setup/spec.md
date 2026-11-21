# member-directory-setup Specification

## Purpose

TBD - created by archiving change shared-project-directory-assignment. Update Purpose after archive.

## Requirements

### Requirement: Shared projects display needs-setup state

The UI SHALL display a visual indicator on shared projects where the current user has not yet configured their local directory. The project SHALL show a warning icon and the "New Thread" action SHALL be disabled until the directory is configured.

#### Scenario: Member sees shared project without configured directory

- **WHEN** a member views the sidebar and has a shared project without a configured `localPath`
- **THEN** the project item displays a warning indicator and the option to create new threads is disabled

#### Scenario: Member sees shared project with configured directory

- **WHEN** a member views the sidebar and has a shared project with a configured `localPath`
- **THEN** the project item displays normally and the option to create new threads is enabled

### Requirement: Directory setup dialog

The system SHALL provide a dialog where members can browse their local filesystem and select a directory to use as their working directory for a shared project. The dialog SHALL use the existing browse API (`GET /api/browse/list`).

#### Scenario: Member opens setup dialog for a shared project

- **WHEN** a member clicks on a shared project that needs setup
- **THEN** a dialog opens with a file browser allowing them to select a local directory

#### Scenario: Member selects a valid directory

- **WHEN** a member selects a directory in the setup dialog and confirms
- **THEN** the system saves the path via `POST /:id/local-path` and the project becomes fully usable

### Requirement: Local path validation

When a member assigns their local directory via the API, the system SHALL validate that the path is an absolute path pointing to a valid git repository. The system SHALL reject paths that are not absolute or that do not contain a git repository.

#### Scenario: Member assigns a valid git repository path

- **WHEN** a member submits an absolute path that contains a valid git repository
- **THEN** the system saves the `localPath` in `project_members` and returns success

#### Scenario: Member assigns a relative path

- **WHEN** a member submits a relative path (e.g., `./my-repo`)
- **THEN** the system rejects the request with a 400 error indicating the path must be absolute

#### Scenario: Member assigns a path that is not a git repository

- **WHEN** a member submits an absolute path that is not a git repository
- **THEN** the system rejects the request with a 400 error indicating the path must be a git repository

### Requirement: Project list includes localPath for current user

The project list API SHALL include the current user's `localPath` and a `needsSetup` flag for shared projects. This allows the client to render the correct state without additional API calls.

#### Scenario: API returns project list with localPath for team projects

- **WHEN** the client requests the project list and the user is a member of shared projects
- **THEN** each shared project in the response includes `localPath` (string or null) and `needsSetup` (boolean) fields

### Requirement: Lazy project_members creation

The `project_members` record SHALL be created lazily when the member assigns their directory — not when the project is initially shared. Visibility is governed by `team_projects`; activation is governed by `project_members`.

#### Scenario: Project shared with org creates no member records

- **WHEN** a project is shared with an organization via `team_projects`
- **THEN** no records are created in `project_members` — members see the project via the org association

#### Scenario: Member assigns directory creates project_members record

- **WHEN** a member assigns their local directory for a shared project
- **THEN** a record is created (or updated) in `project_members` with the user's ID, project ID, role='member', and localPath set to the selected directory
