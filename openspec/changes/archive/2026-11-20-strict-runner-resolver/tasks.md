## 1. Simplify runner-resolver.ts

- [x] 1.1 Remove `resolveAnyOnlineRunner` function entirely
- [x] 1.2 Remove `DEFAULT_RUNNER_URL` constant and its usage
- [x] 1.3 Create `resolveUserRunner(userId)` — queries runners by userId, filters by `isRunnerConnected`, returns first match or null
- [x] 1.4 Simplify `resolveByProject` — single query scoped to userId (remove isNull and unscoped fallbacks), filter by `isRunnerConnected`
- [x] 1.5 Update `resolveRunner` to use `resolveUserRunner` as final strategy instead of `resolveAnyOnlineRunner`
- [x] 1.6 Remove unused `isNull` import from drizzle-orm

## 2. Update thread-registry.ts

- [x] 2.1 Add `userId` parameter to `getRunnerForThread(threadId, userId)`
- [x] 2.2 Add `runners.userId` check to the query — verify runner belongs to requesting user
- [x] 2.3 Filter result by `isRunnerConnected` before returning
- [x] 2.4 Update all call sites of `getRunnerForThread` to pass userId

## 3. Update proxy.ts

- [x] 3.1 Remove tunnel retry logic for "not connected" errors — return 502 immediately
- [x] 3.2 Update 502 error message to `"No runner connected. Check that your runner is online."`
- [x] 3.3 Remove `isRunnerConnected` import from ws-relay (no longer needed in proxy — resolver handles it)

## 4. Cleanup

- [x] 4.1 Remove `resolveRunnerUrl` deprecated function from runner-resolver.ts
- [x] 4.2 Verify build passes: `bun run --cwd packages/server build`
- [ ] 4.3 Test: start server without runtime — all proxied routes return 502 with clear message
- [ ] 4.4 Test: start server + runtime — all proxied routes work, no stale runner warnings
