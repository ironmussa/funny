# arc-data-model Specification

## Purpose
TBD - created by archiving change native-arcs. Update Purpose after archive.

## Requirements

### Requirement: Arcs database table

The system SHALL maintain an `arcs` table with columns: `id` (text PK), `projectId` (FK to projects), `userId` (text, not null), `name` (text, not null), `createdAt` (text, not null). The `name` column SHALL be unique within a project (composite uniqueness on `projectId` + `name`).

#### Scenario: Create a new arc

- **WHEN** a new arc is created with projectId "proj-1", userId "user-1", and name "add-caching"
- **THEN** the system inserts a row in `arcs` with a generated nanoid, the provided fields, and `createdAt` set to the current ISO timestamp

#### Scenario: Prevent duplicate arc names within a project

- **WHEN** an arc with name "add-caching" already exists for projectId "proj-1"
- **THEN** the system SHALL reject creation and return a conflict error

#### Scenario: Allow same arc name across different projects

- **WHEN** an arc with name "add-caching" exists for projectId "proj-1"
- **THEN** creating an arc with name "add-caching" for projectId "proj-2" SHALL succeed

### Requirement: Thread gains arcId and purpose fields

The system SHALL add `arcId` (nullable text FK to arcs) and `purpose` (text, default `'implement'`) columns to the `threads` table. The `purpose` field SHALL accept values `'explore'` or `'implement'`.

#### Scenario: Create a thread linked to an arc

- **WHEN** a thread is created with arcId "arc-1" and purpose "explore"
- **THEN** the thread record SHALL store both fields and the arc SHALL be queryable from the thread

#### Scenario: Create a thread without an arc (backward compatible)

- **WHEN** a thread is created without specifying arcId or purpose
- **THEN** the thread SHALL have `arcId` as null and `purpose` as `'implement'`

### Requirement: Arc deletion cascades to thread unlinking

The system SHALL set `arcId` to null on all linked threads when an arc is deleted. Threads SHALL NOT be deleted when their arc is deleted.

#### Scenario: Delete an arc with linked threads

- **WHEN** arc "arc-1" is deleted and threads T1, T2 are linked to it
- **THEN** threads T1 and T2 SHALL remain in the database with `arcId` set to null

### Requirement: Derive arc status from threads and artifacts

The system SHALL NOT store a status column on the `arcs` table. Arc status SHALL be derived at query time from linked threads and filesystem artifacts.

#### Scenario: Arc with running threads

- **WHEN** arc "add-caching" has at least one thread with status "running"
- **THEN** the derived status SHALL be "active"

#### Scenario: Arc with all tasks completed

- **WHEN** arc "add-caching" has a `tasks.md` file where all checkbox items are checked
- **THEN** the derived status SHALL be "done"

#### Scenario: Arc with proposal artifact only

- **WHEN** arc "add-caching" has a `proposal.md` file but no running threads and incomplete tasks
- **THEN** the derived status SHALL be "proposed"

#### Scenario: Arc with only explore threads

- **WHEN** arc "add-caching" has threads with purpose "explore" but no "implement" threads
- **THEN** the derived status SHALL be "exploring"

#### Scenario: Newly created arc

- **WHEN** arc "add-caching" has no linked threads and no artifacts
- **THEN** the derived status SHALL be "new"
