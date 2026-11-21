## ADDED Requirements

### Requirement: Runtime coordinates background Git fetches per repository

The runtime SHALL coordinate background remote fetches through a single service boundary so callers do not start duplicate background fetches for the same repository path while one is already in flight.

#### Scenario: Duplicate background fetch suppressed

- **WHEN** two background fetch requests target the same repository path while the first fetch is still running
- **THEN** the runtime schedules only one low-level Git fetch
- **AND** the second request reports that no new fetch was scheduled

#### Scenario: Background fetch allowed after completion

- **WHEN** a background fetch for a repository path has completed
- **THEN** a later background fetch request for that repository path can be scheduled if throttle rules allow it

### Requirement: Runtime owns fetch cache invalidation

The runtime SHALL invalidate relevant Git status caches after a coordinated fetch refreshes remote refs.

#### Scenario: Project fetch invalidates project and cwd caches

- **WHEN** a coordinated project fetch succeeds
- **THEN** the runtime invalidates the per-project Git status cache
- **AND** the runtime invalidates the cwd-keyed status summary cache for the fetched repository path

#### Scenario: Thread fetch invalidates thread project cache

- **WHEN** a coordinated thread fetch succeeds
- **THEN** the runtime invalidates the status cache for the thread's project
- **AND** the runtime invalidates the cwd-keyed status summary cache for the fetched working directory

### Requirement: Routes delegate Git fetch policy to the runtime service

Routes SHALL delegate remote fetch policy to the runtime Git coordination service rather than directly calling low-level Git fetch helpers for route-owned behavior.

#### Scenario: Branch route uses coordinated background fetch

- **WHEN** the project branches route refreshes remote refs in the background
- **THEN** it calls the runtime Git coordination service
- **AND** it does not call the low-level Git fetch helper directly

#### Scenario: Explicit fetch route uses coordinated fetch

- **WHEN** a project or thread explicit fetch endpoint is requested
- **THEN** the route calls the runtime Git coordination service
- **AND** the route response shape remains unchanged

### Requirement: Public Git route contracts remain stable

The runtime Git coordination change SHALL NOT alter existing public HTTP route paths, request bodies, or success response shapes.

#### Scenario: Existing clients continue to call Git routes

- **WHEN** an existing client calls a Git status, branches, or fetch endpoint
- **THEN** the endpoint accepts the same request as before
- **AND** returns the same success response shape as before
