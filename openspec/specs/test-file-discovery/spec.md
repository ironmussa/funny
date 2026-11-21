# test-file-discovery Specification

## Purpose

TBD - created by archiving change test-runner-screen. Update Purpose after archive.

## Requirements

### Requirement: Discover Playwright test files for a project

The system SHALL provide an API endpoint `GET /api/tests/:projectId/files` that discovers all Playwright test files (`**/*.spec.ts`) within the project's root directory and returns them as a flat list of relative paths.

#### Scenario: Project with test files

- **WHEN** a GET request is made to `/api/tests/:projectId/files` for a project that has an `e2e/` directory with `.spec.ts` files
- **THEN** the response SHALL be a JSON array of relative file paths (e.g., `["e2e/app.spec.ts", "e2e/review-pane.spec.ts"]`) with status 200

#### Scenario: Project with no test files

- **WHEN** a GET request is made to `/api/tests/:projectId/files` for a project that has no `e2e/` directory or no `.spec.ts` files
- **THEN** the response SHALL be an empty JSON array `[]` with status 200

#### Scenario: Invalid project ID

- **WHEN** a GET request is made to `/api/tests/:projectId/files` with a project ID that does not exist
- **THEN** the response SHALL return status 404 with an error message

### Requirement: Test file paths are relative to project root

The system SHALL return test file paths relative to the project's root directory, not absolute paths.

#### Scenario: File path format

- **WHEN** test files are discovered at `/home/user/project/e2e/login.spec.ts` for a project rooted at `/home/user/project`
- **THEN** the returned path SHALL be `e2e/login.spec.ts`
