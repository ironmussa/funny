# test-execution Specification

## Purpose

TBD - created by archiving change test-runner-screen. Update Purpose after archive.

## Requirements

### Requirement: Run a Playwright test file

The system SHALL provide an API endpoint `POST /api/tests/:projectId/run` that accepts a `{ file: string }` body and spawns a Playwright test process for that specific file with Chrome in headed mode and CDP remote debugging enabled.

#### Scenario: Start a test run

- **WHEN** a POST request is made to `/api/tests/:projectId/run` with `{ "file": "e2e/app.spec.ts" }`
- **THEN** the system SHALL spawn `npx playwright test e2e/app.spec.ts --headed --reporter=line` with `PLAYWRIGHT_CHROMIUM_DEBUG_PORT=9223` in the project directory
- **AND** return status 200 with `{ "runId": "<unique-id>" }`

#### Scenario: Test already running

- **WHEN** a POST request is made to start a test while another test is already running for the same project
- **THEN** the system SHALL return status 409 with `{ "error": "A test is already running" }`

### Requirement: Stop a running test

The system SHALL provide an API endpoint `POST /api/tests/:projectId/stop` that kills the running Playwright process and disconnects the CDP session.

#### Scenario: Stop active test

- **WHEN** a POST request is made to `/api/tests/:projectId/stop` while a test is running
- **THEN** the system SHALL kill the Playwright child process, disconnect the ChromeSession, and emit a `test:status` event with status `stopped`

#### Scenario: No test running

- **WHEN** a POST request is made to `/api/tests/:projectId/stop` while no test is running
- **THEN** the system SHALL return status 200 (idempotent, no error)

### Requirement: Stream browser video via CDP screencast

The system SHALL connect to Chrome's CDP debugging port after test launch, start a screencast session using `ChromeSession` from `packages/podman-chrome-streaming/`, and relay JPEG frames as `test:frame` WebSocket events.

#### Scenario: Frames streamed during test execution

- **WHEN** a test is running and Chrome's CDP port is available
- **THEN** the system SHALL emit `test:frame` WebSocket events containing `{ data: "<base64-jpeg>", timestamp: <number> }` for each screencast frame

#### Scenario: Chrome not ready within timeout

- **WHEN** Chrome's CDP debugging port is not available within 30 seconds after process launch
- **THEN** the system SHALL emit a `test:status` event with `{ status: "error", error: "Chrome debug port not available" }` and continue the test without streaming

### Requirement: Stream test output in real-time

The system SHALL capture stdout and stderr from the Playwright process and emit them as `test:output` WebSocket events line by line.

#### Scenario: Test output lines

- **WHEN** the Playwright process writes to stdout or stderr
- **THEN** the system SHALL emit `test:output` events with `{ line: "<text>", stream: "stdout" | "stderr" }` for each line

### Requirement: Emit test lifecycle status events

The system SHALL emit `test:status` WebSocket events for test lifecycle transitions.

#### Scenario: Test starts

- **WHEN** a test process is successfully spawned
- **THEN** the system SHALL emit `test:status` with `{ status: "running", file: "<path>", runId: "<id>" }`

#### Scenario: Test completes successfully

- **WHEN** the Playwright process exits with code 0
- **THEN** the system SHALL emit `test:status` with `{ status: "passed", file: "<path>", runId: "<id>" }`

#### Scenario: Test fails

- **WHEN** the Playwright process exits with a non-zero code
- **THEN** the system SHALL emit `test:status` with `{ status: "failed", file: "<path>", runId: "<id>", exitCode: <number> }`

#### Scenario: Test stopped by user

- **WHEN** the user stops a running test via `/api/tests/:projectId/stop`
- **THEN** the system SHALL emit `test:status` with `{ status: "stopped", file: "<path>", runId: "<id>" }`
