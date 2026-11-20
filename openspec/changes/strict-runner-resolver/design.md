## Context

The runner resolver (`packages/server/src/services/runner-resolver.ts`) determines which runner handles each proxied HTTP request. Currently it uses a 4-strategy cascade: thread cache → project assignment → thread DB → `resolveAnyOnlineRunner`. The last strategy finds "any online runner" regardless of ownership, which violates tenant isolation and returns stale runners whose DB status is 'online' but whose WebSocket is disconnected.

The resolver also maintains two independent views of runner state: **DB status** (updated by heartbeats, registration) and **WS connection map** (in-memory, updated by WebSocket open/close). These frequently diverge, causing requests to route to runners that can't be reached via tunnel.

## Goals / Non-Goals

**Goals:**

- Every proxied request goes to the requesting user's runner, or fails with 502
- Runner availability is determined by WebSocket connection (in-memory truth), not DB status
- Fast failure — if the user's runner is not connected, return 502 immediately (no retries against dead runners)
- Clear error messages — 502 body tells the user their runner is not connected

**Non-Goals:**

- Changing the WS tunnel transport (that's a separate initiative)
- Multi-runner per user support (each user has one runner for now)
- Changing how runners register or authenticate

## Decisions

### 1. Single source of truth: WS connection map

**Decision**: Use `isRunnerConnected(runnerId)` as the authoritative check for runner availability. DB status is used only for finding the user's runner ID, not for determining if it's reachable.

**Rationale**: The DB status lags behind reality (heartbeat intervals, race conditions between HTTP registration and WS connection). The WS map is always current — if the runner is in the map, the tunnel will work.

**Alternative considered**: Keeping DB status as primary with WS as tiebreaker. Rejected because this is exactly the current design that causes stale routing.

### 2. Replace `resolveAnyOnlineRunner` with `resolveUserRunner`

**Decision**: New function `resolveUserRunner(userId)` that:

1. Queries `runners` table for runners with `userId` matching the requesting user
2. Filters to only those present in the WS connection map (`isRunnerConnected`)
3. Returns the first match or null

No fallback to runners without userId. No fallback to any online runner.

**Rationale**: A user's request must only go to their runner. If their runner is down, 502 is the correct response — silently routing elsewhere is a security violation.

### 3. Simplify `resolveByProject` to single query

**Decision**: Replace the 3-condition cascade with a single query:

```sql
SELECT rpa.runnerId, r.httpUrl
FROM runnerProjectAssignments rpa
JOIN runners r ON r.id = rpa.runnerId
WHERE rpa.projectId = ? AND r.userId = ?
```

Then filter by `isRunnerConnected`. No `isNull(userId)` fallback, no unscoped fallback.

**Rationale**: The cascading conditions were workarounds for runners registered without userId. Now that auth.ts always sets userId on registration, the fallbacks are unnecessary and dangerous.

### 4. Proxy: no retry on "not connected"

**Decision**: When `resolveRunner` returns a runner but the tunnel fails with "not connected", do NOT retry. Return 502 immediately.

**Rationale**: If the resolver returned a runner that passed `isRunnerConnected` but the tunnel still fails, it means the WS closed between the check and the send — a microsecond race. Retrying won't help; the runner needs to reconnect. The client will retry the HTTP request naturally.

### 5. Remove `DEFAULT_RUNNER_URL`

**Decision**: Remove the `DEFAULT_RUNNER_URL` env var and its handling code.

**Rationale**: This is a backdoor that bypasses all runner isolation. If someone needs a fixed runner URL, they should register it properly as a runner with userId.

## Risks / Trade-offs

- **[Risk] Brief 502 window on server restart** — Between server start and runtime reconnecting (~2s), all requests will 502. → Acceptable: this is already the case, and now the error is clear instead of a delayed timeout.
- **[Risk] Runners registered without userId stop working** — Any existing runner with `userId = null` won't be found by `resolveUserRunner`. → Mitigation: `purgeAllRunners()` on startup already clears these. The auth middleware now always sets userId.
- **[Trade-off] Less "magical" recovery** — The old system would sometimes find a working runner via fallback. The new system fails fast. → This is intentional: clear failures are better than silent misrouting.
