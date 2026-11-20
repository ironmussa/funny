## Purpose

Defines the versioned REST API through which clients outside the web app (the Chrome extension and scripts) list projects and create threads, authenticated with personal API tokens, documented by an OpenAPI document generated from the same procedures the server implements.

## ADDED Requirements

### Requirement: Versioned public REST endpoints generated from typed procedures

The server SHALL serve the public API under `/api/v1/*`. Each endpoint SHALL be generated from a procedure that declares its HTTP method, path, input schema and output schema. Responses SHALL be validated against the output schema, and fields the schema does not declare SHALL NOT be returned. The server SHALL serve an OpenAPI 3 document describing every public endpoint at `GET /api/v1/openapi.json`.

#### Scenario: Listing projects returns only declared fields

- **WHEN** an authenticated token holder calls `GET /api/v1/projects`
- **THEN** the response lists the caller's owned and shared projects with exactly the fields of the published project schema

#### Scenario: The OpenAPI document describes the public surface

- **WHEN** anyone requests `GET /api/v1/openapi.json`
- **THEN** the response is an OpenAPI 3 document listing every `/api/v1` endpoint with its input, output and Bearer security scheme, and no other endpoint

### Requirement: Only explicitly published procedures are exposed

A procedure SHALL be reachable under `/api/v1` only if it belongs to the public router and is on the published allow-list. The procedures the web client calls at `/api/trpc/*` SHALL NOT be reachable under `/api/v1`, and public procedures SHALL NOT be reachable under `/api/trpc`. The repository SHALL automatically reject a public procedure without an output schema or outside the allow-list.

#### Scenario: A web procedure is not exposed

- **WHEN** a client calls `/api/v1/` with the path of a procedure that only the web router defines
- **THEN** the server answers 404

#### Scenario: Missing output schema fails lint

- **WHEN** a change adds a public procedure without an output schema
- **THEN** the repository lint fails and names the procedure

### Requirement: Thread creation through the caller's own runner

`POST /api/v1/threads` SHALL create a thread in a project the caller may create threads in and start it on a runner owned by the caller and in scope for the project, through the same server-side creation use case and runner-isolation checks as thread creation from the web app. If no such runner is available, the request SHALL fail with 502 and SHALL NOT use another user's runner. A project the caller cannot access SHALL answer 404.

#### Scenario: Thread created on the caller's runner

- **WHEN** a token holder posts a valid prompt for a project they own while their runner is online
- **THEN** the thread is created with source `chrome_extension` or `api`, started on their runner, and its id is returned

#### Scenario: Runner offline

- **WHEN** the caller's runner for the project is offline
- **THEN** the request fails with 502 and no other user's runner receives it

#### Scenario: Someone else's project

- **WHEN** a token holder posts a thread for a project they have no access to
- **THEN** the server answers 404 and creates nothing

### Requirement: Personal API tokens

A user SHALL be able to create, list and revoke personal API tokens. A token's plaintext SHALL be shown only at creation and stored only as a hash. Each token SHALL have an expiry. A token SHALL authenticate requests to `/api/v1/*` only. On any other path it SHALL be rejected with 401 and SHALL NOT be treated as a session. Creating, revoking, and rejecting an expired or revoked token SHALL be audited.

#### Scenario: Token authenticates the public API

- **WHEN** a request to `/api/v1/projects` carries `Authorization: Bearer` with a valid, unexpired token
- **THEN** it runs as the token's owner

#### Scenario: Token cannot reach other routes

- **WHEN** a request to `/api/trpc/projects.list` or any runner-proxied route carries only a personal API token
- **THEN** the server answers 401

#### Scenario: Revoked token is refused

- **WHEN** a revoked or expired token is used
- **THEN** the server answers 401 and records the rejection

### Requirement: Chrome extension uses the public API

The Chrome extension SHALL authenticate with a personal API token entered by the user and SHALL call only `/api/v1/*` endpoints. It SHALL request host access only for the server origin the user configured.

#### Scenario: Sending an annotation creates a thread

- **WHEN** a user with a configured server URL and token sends an annotated page from the extension
- **THEN** the extension calls `POST /api/v1/threads` with the token and shows the created thread
