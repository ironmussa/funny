# test-runner-ui Specification

## Purpose

TBD - created by archiving change test-runner-screen. Update Purpose after archive.

## Requirements

### Requirement: Test file browser with tree view

The TestRunnerPane SHALL display a tree view of all discovered Playwright test files, grouped by folder with expand/collapse chevrons, using the same virtualized list pattern as ReviewPane.

#### Scenario: Files displayed in tree

- **WHEN** the test runner pane is opened and the project has test files
- **THEN** the system SHALL display all `.spec.ts` files organized by folder with expand/collapse chevrons and file names

#### Scenario: No test files found

- **WHEN** the test runner pane is opened and no test files exist for the project
- **THEN** the system SHALL display a "No test files found" empty state

### Requirement: Search and filter test files

The test file browser SHALL include a search input at the top that filters the file list by file name as the user types.

#### Scenario: Filter by name

- **WHEN** the user types "login" in the search input
- **THEN** only test files whose path contains "login" SHALL be displayed

#### Scenario: Clear search

- **WHEN** the user clears the search input
- **THEN** all test files SHALL be displayed again

### Requirement: Play button per test file

Each test file in the browser SHALL display a play button (▶) that triggers execution of that specific test file.

#### Scenario: Click play on a file

- **WHEN** the user clicks the play button on `e2e/app.spec.ts`
- **THEN** the system SHALL send a POST to `/api/tests/:projectId/run` with `{ "file": "e2e/app.spec.ts" }`

#### Scenario: Play disabled during active run

- **WHEN** a test is currently running
- **THEN** all play buttons SHALL be disabled and the running file SHALL show a spinner indicator

### Requirement: Run All button

The test file browser toolbar SHALL include a "Run All" button that runs all discovered test files sequentially.

#### Scenario: Run all tests

- **WHEN** the user clicks "Run All"
- **THEN** the system SHALL queue all test files and run them one at a time, updating status indicators as each completes

### Requirement: Per-file status indicators

Each test file SHALL display a status indicator dot showing its current state.

#### Scenario: Status states

- **WHEN** a test file has not been run
- **THEN** it SHALL show a gray idle indicator
- **WHEN** a test file is currently running
- **THEN** it SHALL show a blue spinning indicator
- **WHEN** a test file has passed
- **THEN** it SHALL show a green dot
- **WHEN** a test file has failed
- **THEN** it SHALL show a red dot

### Requirement: Browser preview canvas

The TestRunnerPane SHALL display a `<canvas>` element that renders live CDP screencast frames received via `test:frame` WebSocket events.

#### Scenario: Frames rendered on canvas

- **WHEN** `test:frame` events are received with base64 JPEG data
- **THEN** the system SHALL decode the JPEG and draw it on the canvas using `drawImage()`

#### Scenario: No test running

- **WHEN** no test is running
- **THEN** the canvas area SHALL display a "No test running" placeholder

#### Scenario: Connecting state

- **WHEN** a test has been started but no frames have arrived yet
- **THEN** the canvas area SHALL display "Connecting to browser..."

### Requirement: Test output log

The TestRunnerPane SHALL display a scrollable log area below the browser preview showing real-time test output from `test:output` WebSocket events.

#### Scenario: Output lines displayed

- **WHEN** `test:output` events are received
- **THEN** each line SHALL be appended to the log area with stdout in default color and stderr in red

#### Scenario: Log auto-scrolls

- **WHEN** new output lines arrive
- **THEN** the log area SHALL auto-scroll to the bottom unless the user has manually scrolled up

### Requirement: Stop button during test execution

The TestRunnerPane SHALL display a stop button (■) when a test is running.

#### Scenario: Stop running test

- **WHEN** the user clicks the stop button
- **THEN** the system SHALL send a POST to `/api/tests/:projectId/stop`
- **AND** the test status SHALL change to "stopped"

### Requirement: Test runner state management

A Zustand store (`test-store.ts`) SHALL manage test runner state including: discovered file list, running state, active run ID, per-file status results, and output log lines.

#### Scenario: Store tracks test results

- **WHEN** a test completes with `test:status` event
- **THEN** the store SHALL update the status for that file (passed/failed/stopped)
- **AND** retain results until a new run is started or the project changes
