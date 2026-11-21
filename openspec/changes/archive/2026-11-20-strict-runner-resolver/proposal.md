## Why

The runner resolver (`runner-resolver.ts`) has a `resolveAnyOnlineRunner` fallback that routes requests to any online runner when the user's specific runner can't be found. This violates tenant isolation (a user's request could theoretically reach another user's runner), returns stale runners that are "online" in the DB but disconnected via WebSocket, and masks real connectivity issues by silently routing to dead runners — causing 502s after 1-3s of retries instead of failing fast with a clear message.

## What Changes

- **BREAKING**: Remove `resolveAnyOnlineRunner` — no more "find any runner" fallback. If the user's runner is not connected, return 502 immediately.
- Simplify `resolveRunner` to a strict resolution chain: thread cache → project assignment → thread DB → **null** (no fallback).
- Replace multi-strategy `resolveByProject` (3 cascading conditions with userId, isNull, any) with a single query scoped to the user's runners.
- All resolution paths must verify the runner is **actually connected** via WebSocket (`isRunnerConnected`), not just "online" in the DB. DB status is advisory; WS connection is truth.
- Add `resolveUserRunner` — a simple function that returns the user's connected runner or null. Used for routes without projectId/threadId context (e.g., `/api/browse/*`, `/api/system/*`).
- Remove `DEFAULT_RUNNER_URL` fallback (dead code path, same anti-pattern).
- Improve 502 error messages to tell the user their runner is not connected (actionable vs opaque).

## Capabilities

### New Capabilities

- `strict-runner-resolution`: Enforces that every proxied request is routed exclusively to the requesting user's runner, verified by active WebSocket connection. No cross-user fallbacks.

### Modified Capabilities

<!-- No existing specs to modify -->

## Impact

- **`packages/server/src/services/runner-resolver.ts`** — Primary refactor target. Simplified from ~225 lines to ~100.
- **`packages/server/src/middleware/proxy.ts`** — Better 502 error messages; reduced retry delay (runner won't magically appear).
- **`packages/server/src/services/thread-registry.ts`** — `getRunnerForThread` should verify runner belongs to requesting user.
- **`packages/server/src/index.ts`** — WS close handler already marks runner offline; no changes needed.
- **Client impact**: 502 responses will have clearer error messages. No API shape changes.
