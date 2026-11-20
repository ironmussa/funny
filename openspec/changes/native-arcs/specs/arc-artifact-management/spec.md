## ADDED Requirements

### Requirement: Create arc directory on arc creation

The system SHALL create the `arcs/<name>/` directory in the project repository when a new arc is created. The directory SHALL be created at the resolved project path (respecting per-user path resolution for team projects).

#### Scenario: Arc directory created

- **WHEN** an arc named "add-caching" is created for a project at `/home/user/my-project`
- **THEN** the directory `/home/user/my-project/arcs/add-caching/` SHALL be created

#### Scenario: Arcs parent directory created lazily

- **WHEN** the `arcs/` parent directory does not exist in the project
- **THEN** the system SHALL create `arcs/` before creating the `arcs/<name>/` subdirectory

### Requirement: Read arc artifacts from filesystem

The system SHALL read arc artifact files from the project filesystem. It SHALL look for `proposal.md`, `design.md`, `tasks.md`, and any `specs/*/spec.md` files within the `arcs/<name>/` directory.

#### Scenario: All artifacts present

- **WHEN** `arcs/add-caching/` contains proposal.md, design.md, tasks.md, and specs/cache-storage/spec.md
- **THEN** reading artifacts SHALL return all four files with their content

#### Scenario: No artifacts present

- **WHEN** `arcs/add-caching/` is an empty directory
- **THEN** reading artifacts SHALL return an empty result (no error)

#### Scenario: Specs subdirectories

- **WHEN** `arcs/add-caching/specs/` contains `cache-storage/spec.md` and `cache-invalidation/spec.md`
- **THEN** reading artifacts SHALL return both spec files with their content keyed by capability name

### Requirement: Arc name validation

Arc names SHALL be validated as kebab-case strings: lowercase letters, numbers, and hyphens only. Names SHALL NOT start or end with a hyphen. Maximum length SHALL be 100 characters.

#### Scenario: Valid arc name

- **WHEN** an arc is created with name "add-user-auth-v2"
- **THEN** validation SHALL pass

#### Scenario: Invalid arc name with spaces

- **WHEN** an arc is created with name "add user auth"
- **THEN** validation SHALL fail with an error message indicating kebab-case format is required

#### Scenario: Invalid arc name with uppercase

- **WHEN** an arc is created with name "Add-Caching"
- **THEN** validation SHALL fail
