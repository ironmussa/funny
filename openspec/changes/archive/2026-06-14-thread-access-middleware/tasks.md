## 1. Middleware + predicates

- [x] 1.1 Create `packages/server/src/middleware/thread-access.ts` exporting predicates `isThreadOwner(thread, userId)` and `canViewThread(thread, userId)` (today identical to ownership; the `thread-sharing` change widens `canViewThread`).
- [x] 1.2 Add Hono middlewares `requireThreadView` and `requireThreadOwner`: resolve via `threadRepo.getThread(id)`, return `404 Thread not found` when missing or unauthorized, and `c.set('thread', thread)` on success.
- [x] 1.3 Declare `thread` on the Hono context `Variables` type so `c.get('thread')` is typed across thread routes.

## 2. Apply to routes

- [x] 2.1 In `packages/server/src/routes/threads.ts`, mount `requireThreadView` on read routes (detail, messages, events, comments list/create) and `requireThreadOwner` on mutation/lifecycle/fork/rewind routes. Remove the 17 inline `!thread || thread.userId !== userId` checks; handlers read `c.get('thread')`.
- [~] 2.2 ~~Apply `requireThreadOwner` to the git routes (`/api/git/:id/*`).~~ **Deferred to `thread-sharing`.** Implementation revealed `/api/git/*` has no explicit server route — it falls through `app.all('/api/*', proxyToRunner)` (index.ts:325) and is owner-only via runner-isolation, not an explicit gate. Adding `requireThreadOwner` is therefore a behavior change (non-owner 502/mis-route → 404 + an extra DB fetch), not part of this behavior-preserving refactor. Its security value (preventing a _sharee's_ git request from being routed to their own runner) only materializes once sharing exists, so it lives in `thread-sharing` (task 2.3 there).
- [x] 2.3 Preserve the messages hot path: avoid adding a redundant query — either have the middleware-loaded thread satisfy the existence check while the handler fetches only messages, or keep `getThreadWithMessages` and use the middleware solely for authorization.

## 3. Tests

- [x] 3.1 Confirm the existing `routes/threads` and git-route tests pass unchanged (behavior-preserving refactor).
- [x] 3.2 Add a middleware unit test: owner authorized on both classes; non-owner `404` on both; missing thread `404`; loaded thread reachable via `c.get('thread')` in the handler.
- [x] 3.3 Add an existence-hiding assertion: a non-owner request to an existing thread returns the byte-identical `404` as a nonexistent id.
