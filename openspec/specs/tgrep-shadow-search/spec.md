# tgrep-shadow-search Specification

## Purpose
Provide bounded tgrep content search and independent file search without FFF.

## Requirements

### Requirement: Content search

The runtime SHALL use tgrep 1.0.5 exclusively for content search with a default 1,000-row limit and a maximum 10,000-row limit.

#### Scenario: Successful query

- **WHEN** a content query completes
- **THEN** its results and truncation metadata are returned

#### Scenario: Unavailable backend

- **WHEN** startup or a content request fails
- **THEN** a sanitized error is returned and the next query retries with a new client while file search remains usable

### Requirement: File search

The runtime SHALL rank file paths with Funny's shared smart-case fuzzy scorer and refresh the list periodically and on rescan.

#### Scenario: Git repository

- **WHEN** a file query is issued
- **THEN** tracked and untracked nonignored paths are ranked with bounded matches and truncation metadata

#### Scenario: Scratch directory

- **WHEN** the directory is outside Git
- **THEN** the directory walker supplies paths excluding heavy dependency and build directories

### Requirement: Scoped bounded lifecycle

The runtime SHALL isolate state per resident worktree, bound startup and request resources, and stop owned processes on rescan or disposal.

#### Scenario: Invalidation or shutdown

- **WHEN** the provider is disposed
- **THEN** pending results are rejected and owned processes and temporary state are cleaned up

#### Scenario: Branch rescan

- **WHEN** a provider is rescanned
- **THEN** pending old results are rejected, the file list refreshes and the next content query uses a new index

#### Scenario: Invalid or oversized response

- **WHEN** a response is malformed, exceeds limits or misses its deadline
- **THEN** the content request fails without exposing raw backend details
