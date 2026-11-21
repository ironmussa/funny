# arc-api Specification

## Purpose

TBD - created by archiving change native-arcs. Update Purpose after archive.

## Requirements

### Requirement: List arcs for a project

The system SHALL expose `GET /api/projects/:id/arcs` which returns all arcs belonging to the specified project for the authenticated user. Each arc in the response SHALL include `id`, `name`, `createdAt`, and a `threadCount` indicating the number of linked threads.

#### Scenario: Project with arcs

- **WHEN** a GET request is made to `/api/projects/proj-1/arcs` by an authenticated user
- **THEN** the response SHALL be a JSON array of arcs belonging to that project and user, with status 200

#### Scenario: Project with no arcs

- **WHEN** a GET request is made to `/api/projects/proj-1/arcs` and no arcs exist
- **THEN** the response SHALL be an empty JSON array with status 200

### Requirement: Create an arc

The system SHALL expose `POST /api/projects/:id/arcs` which creates a new arc. The request body SHALL contain `name` (kebab-case string). The system SHALL create the `arcs/<name>/` directory in the project repository.

#### Scenario: Successful arc creation

- **WHEN** a POST request is made with `{"name": "add-caching"}` for project "proj-1"
- **THEN** the system SHALL create the arc record in the database, create the `arcs/add-caching/` directory in the project path, and return the arc object with status 201

#### Scenario: Invalid arc name format

- **WHEN** a POST request is made with `{"name": "Add Caching!!"}`
- **THEN** the system SHALL reject with status 400 and a validation error indicating the name must be kebab-case

#### Scenario: Duplicate arc name

- **WHEN** a POST request is made with a name that already exists for that project
- **THEN** the system SHALL reject with status 409

### Requirement: Get arc details with artifacts

The system SHALL expose `GET /api/arcs/:id` which returns the arc record plus the content of any existing artifact files (proposal.md, design.md, tasks.md, specs/).

#### Scenario: Arc with artifacts

- **WHEN** a GET request is made to `/api/arcs/arc-1` and the arc has proposal.md and design.md
- **THEN** the response SHALL include the arc metadata and an `artifacts` object with `proposal` and `design` fields containing the file contents

#### Scenario: Arc with no artifacts

- **WHEN** a GET request is made to `/api/arcs/arc-1` and no artifact files exist
- **THEN** the response SHALL include the arc metadata and an empty `artifacts` object

### Requirement: List threads linked to an arc

The system SHALL expose `GET /api/arcs/:id/threads` which returns all threads linked to the specified arc.

#### Scenario: Arc with linked threads

- **WHEN** a GET request is made to `/api/arcs/arc-1/threads`
- **THEN** the response SHALL be a JSON array of thread objects where `arcId` equals "arc-1"

### Requirement: Delete an arc

The system SHALL expose `DELETE /api/arcs/:id` which deletes the arc record. Linked threads SHALL have their `arcId` set to null. The filesystem artifacts SHALL NOT be deleted (they remain in the repo).

#### Scenario: Delete arc with linked threads

- **WHEN** a DELETE request is made to `/api/arcs/arc-1`
- **THEN** the arc record SHALL be removed, linked threads SHALL have `arcId` set to null, and `arcs/<name>/` directory SHALL remain on the filesystem

### Requirement: Thread creation accepts arcId and purpose

The existing `POST /api/threads` endpoint SHALL accept optional `arcId` (string) and `purpose` (`'explore'` | `'implement'`) fields in the request body.

#### Scenario: Create thread linked to arc

- **WHEN** a POST request to `/api/threads` includes `arcId: "arc-1"` and `purpose: "explore"`
- **THEN** the created thread SHALL have those fields stored and the agent SHALL receive arc context in its systemPrefix

#### Scenario: Create thread without arc fields

- **WHEN** a POST request to `/api/threads` omits `arcId` and `purpose`
- **THEN** the thread SHALL be created with `arcId: null` and `purpose: "implement"` (backward compatible)
