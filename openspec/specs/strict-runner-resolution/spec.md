# strict-runner-resolution Specification

## Purpose
TBD - created by archiving change strict-runner-resolver. Update Purpose after archive.

## Requirements

### Requirement: User-scoped runner resolution

The resolver SHALL only return runners that belong to the requesting user (matched by `runners.userId`). The resolver SHALL NOT fall back to runners belonging to other users or runners without a userId.

#### Scenario: User's runner is connected

- **WHEN** a proxied request arrives with userId "user-1" and user-1 has a runner with an active WebSocket connection
- **THEN** the resolver returns that runner

#### Scenario: User's runner exists but is not connected via WebSocket

- **WHEN** a proxied request arrives with userId "user-1" and user-1 has a runner in the DB marked 'online' but without an active WebSocket connection
- **THEN** the resolver returns null (runner is not reachable)

#### Scenario: User has no runner

- **WHEN** a proxied request arrives with userId "user-1" and no runner exists with `userId = "user-1"`
- **THEN** the resolver returns null even if other users have connected runners

### Requirement: WebSocket connection as availability truth

The resolver SHALL use the in-memory WebSocket connection map (`isRunnerConnected`) as the authoritative check for runner availability. DB status (online/offline) SHALL NOT be used to determine if a runner is reachable.

#### Scenario: DB says online but WS disconnected

- **WHEN** a runner has `status = 'online'` in the database but is not present in the WebSocket connection map
- **THEN** the resolver treats this runner as unavailable and does not return it

#### Scenario: DB says offline but WS connected

- **WHEN** a runner has `status = 'offline'` in the database but IS present in the WebSocket connection map
- **THEN** the resolver treats this runner as available and returns it

### Requirement: Fast failure on unavailable runner

The proxy SHALL return 502 immediately when no connected runner is found for the user. The proxy SHALL NOT retry tunnel requests when the runner is not in the WebSocket connection map.

#### Scenario: No runner available returns 502

- **WHEN** `resolveRunner` returns null for a proxied request
- **THEN** the server returns HTTP 502 with body `{"error": "No runner connected. Check that your runner is online."}`

#### Scenario: No retry on not-connected tunnel failure

- **WHEN** a tunnel request fails with "Runner X is not connected"
- **THEN** the proxy returns 502 immediately without retrying

### Requirement: Project resolution scoped to user

The `resolveByProject` function SHALL only match runners assigned to the project that also belong to the requesting user. There SHALL be no fallback to runners with null userId or runners belonging to other users.

#### Scenario: Project assigned to user's runner

- **WHEN** project "proj-1" is assigned to runner "runner-A" which belongs to userId "user-1", and the request comes from userId "user-1"
- **THEN** the resolver returns "runner-A" (if WebSocket connected)

#### Scenario: Project assigned to another user's runner

- **WHEN** project "proj-1" is assigned to runner "runner-B" which belongs to userId "user-2", and the request comes from userId "user-1"
- **THEN** the resolver does not return "runner-B" and continues to the next resolution strategy

### Requirement: Thread resolution scoped to user

The `getRunnerForThread` function SHALL verify that the runner associated with a thread belongs to the requesting user before returning it.

#### Scenario: Thread's runner belongs to requesting user

- **WHEN** thread "thread-1" has `runnerId = "runner-A"` and runner-A belongs to userId "user-1", and the request comes from userId "user-1"
- **THEN** the resolver returns "runner-A" (if WebSocket connected)

#### Scenario: Thread's runner belongs to another user

- **WHEN** thread "thread-1" has `runnerId = "runner-A"` and runner-A belongs to userId "user-2", and the request comes from userId "user-1"
- **THEN** the resolver does not return "runner-A"

### Requirement: No default runner URL fallback

The resolver SHALL NOT use a `DEFAULT_RUNNER_URL` environment variable as a fallback. All requests MUST be routed through properly registered and user-scoped runners.

#### Scenario: DEFAULT_RUNNER_URL is set but ignored

- **WHEN** `DEFAULT_RUNNER_URL` is configured and no connected runner is found for the user
- **THEN** the resolver returns null (does not use the default URL)
