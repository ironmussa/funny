## 1. Shared: data model + repository

- [x] 1.1 Add a `thread_shares` table to `packages/shared/src/db/schema.sqlite.ts` and `schema.pg.ts`: `threadId` (FK `threads.id`, cascade delete), `sharedWithUserId`, `sharedByUserId`, `createdAt`; composite PK `(threadId, sharedWithUserId)`.
- [x] 1.2 Wire the migration in `packages/server/src/db/migrate.ts` (next migration number) and re-export the table from `server/src/db/schema.ts`.
- [x] 1.3 Create `packages/shared/src/repositories/thread-share-repository.ts` (factory shape mirroring `comment-repository.ts`): `createShare`, `listSharesForThread`, `listThreadsSharedWithUser`, `hasShare`, `deleteShare`. Export from `repositories/index.ts`.
- [x] 1.4 Add a unit test for the repo: create → hasShare true → list → delete → hasShare false.

## 2. Server: widen read access (depends on `thread-access-middleware`)

- [x] 2.1 Widen `canViewThread` in `packages/server/src/middleware/thread-access.ts` from "owner only" to "owner OR `hasShare(thread.id, userId)`". This is the single authorization edit — `requireThreadView` / `requireThreadOwner` and the route mounts already exist from the prerequisite change.
- [x] 2.2 Confirm comment-create (`POST /:id/comments`) is mounted on `requireThreadView` (so sharees can comment) and that all mutation/lifecycle/fork/rewind routes remain on `requireThreadOwner`.
- [x] 2.3 **Add** an explicit owner-only gate to the git routes. `/api/git/:id/*` has no server route today — it falls through `app.all('/api/*', proxyToRunner)` (index.ts:325) and is owner-only only via runner-isolation. Without an explicit gate, a sharee's git request would resolve to _their own_ runner (they're a project member with their own checkout) and silently operate on the wrong working copy. Mount an explicit `/api/git/:id/*` route group guarded by `requireThreadOwner` (from `thread-access-middleware`) so a sharee cleanly gets `404` before any proxy. Deferred here from `thread-access-middleware` task 2.2 because the behavior change (non-owner 502/mis-route → 404) only has security value once sharees exist. Add a test: a sharee is `404` on a git route while the owner still proxies through.

## 3. Server: share admin routes

- [x] 3.1 `POST /api/threads/:id/shares` (owner-only): validate the target `userId` is a co-member of one of the owner's organizations; reject `400` otherwise; insert grant; return it.
- [x] 3.2 `GET /api/threads/:id/shares` (owner-only): list current grants with the invited users' display info (name/image) for the share UI.
- [x] 3.3 `DELETE /api/threads/:id/shares/:userId` (owner-only): delete grant, then evict + notify (see 4.4).
- [x] 3.4 Include "shared with me" threads in the invitee's thread listing (extend `listThreads` / a dedicated query using `listThreadsSharedWithUser`), tagged so the client can bucket them.

## 4. Server: per-thread WS room + presence

- [x] 4.1 In `ws-relay.ts`, add `thread:${id}` room helpers: `joinThreadRoom(socketId, threadId)`, `leaveThreadRoom`, and `relayToThread(threadId, event)`.
- [x] 4.2 Route in-thread agent events (assistant message, tool call, result) to `thread:${id}`; keep cross-thread/sidebar events (status, cost, new-thread) on `user:${ownerId}`. Partition by event category so the owner's socket never double-receives.
- [x] 4.3 In the browser socket handler (`services/socketio/*`), add a "open thread" message that validates `canViewThread` server-side before `socket.join('thread:'+id)`; refuse otherwise. Model presence as an **awareness-shaped ephemeral map** (per-connection `clientID` → `{ user:{id,name,image}, cursor? }`) carried over the `thread:${id}` room — local-origin set + diff broadcast on join/update, timeout/removal on `disconnect`/leave — so it can later swap onto a Yjs awareness provider without a rewrite (see design D8). Do NOT introduce a `Y.Doc` or `y-websocket` server.
- [x] 4.4 On revoke, force-leave the revoked user's sockets from `thread:${id}` and emit `thread:share-revoked { threadId }` to them.

## 5. Client: API + state

- [ ] 5.1 Add `shareThread`, `unshareThread`, `listThreadShares` to `packages/client/src/lib/api/threads.ts`.
- [ ] 5.2 In `hooks/use-ws.ts`: join the thread room on thread open; handle `presence:join` / `presence:leave` into a per-thread viewer set; handle `thread:share-revoked`; source the in-thread live stream from the thread-room events.
- [ ] 5.3 Add a shared-thread variant predicate (e.g. `isReadOnlyShare(thread)`) to `packages/client/src/lib/thread-variant.ts`; do not branch on share-state at call sites.

## 6. Client: UI

- [ ] 6.1 Add a "Share" affordance to the `ThreadView` header (owner-only): an org-member picker (shadcn `Command`/`Popover`) plus copy-link; list/revoke current shares. Add `data-testid`s.
- [ ] 6.2 Render a live presence avatar stack in the header from the viewer set (self excluded), using `users.image`.
- [ ] 6.3 Apply the read-only treatment for shared (non-owner) threads via `isReadOnlyShare`: hide/disable prompt input, start/stop, review pane, fork/rewind, model/permission selectors; keep the comment input enabled.
- [ ] 6.4 Add a "Shared with me" **top-level nav bucket** (sibling of Activity / Projects): a cross-project feed reusing the `ActivityPane` / `AllThreadsView` pattern, its route in `App.tsx`, and the nav entry. Backed by the shared-with-me listing (3.4).
- [x] 6.5 Build the comments panel (the surface 6.3 assumed but never existed — see design D9). Add a `'comments'` value to `RightPaneTab` in `ui-store.ts` plus a `setCommentsPaneOpen` action cloned from `setFilesPaneOpen`; render it from `App.tsx`'s `singleRightPanel` branch (`rightPaneTab === 'comments' → <CommentsPane/>`), a **sibling of `'files'`/`'activity'`** — NOT a dockview sub-tab under `'review'`, NOT a `Sheet` overlay. Create `CommentsPane.tsx`: chronological list via `getThreadComments`, an input that posts via `createThreadComment`, and a per-row delete (`deleteThreadComment`) shown for one's own comments (owner may delete any). Add `data-testid`s.
- [x] 6.6 Add the 💬 comments header icon in `ProjectHeader` as a clone of `header-toggle-project-files` (toggle open/close on `rightPaneTab === 'comments'`), with a badge sourced from `Thread.commentCount`. Gate its visibility with a new `canShowComments(thread)` predicate in `thread-variant.ts` (visible to **any viewer — owner OR sharee — including no-git shared/scratch threads**); do not inline the check. Update the read-only-share footer in `ThreadChatView` from the "you can comment" promise to a pointer to the panel.
- [x] 6.7 Broadcast comment-create over the existing `thread:${id}` room as `thread:comment` (server `ws-relay.ts` / the comment POST path) and handle it in `hooks/use-ws.ts` so a sharee's comment appears live to all viewers; the client refetches on panel open as a backstop. (Closes the live-update gap noted in D9.)

## 7. Tests

- [ ] 7.1 Server: sharee can `GET` detail/messages/events/comments and `POST` a comment; sharee is `404` on follow-up, start, stop, fork, rewind, and every `/api/git/*` route.
- [ ] 7.2 Server: non-org user cannot be granted (`400`); non-granted org member is `404` on read (identity-gated link).
- [ ] 7.3 Server: revoke → revoked user is `404` on next read and is evicted from the thread room.
- [ ] 7.4 WS: join gated by `canViewThread`; presence join/leave round-trips to other viewers; a non-viewer receives no thread events.
- [ ] 7.5 Confirm sharee comments are not added to the agent prompt (regression guard on the comment path).
- [x] 7.6 Client: the 💬 comments icon is visible to a sharee (non-owner), opening it renders the panel and `createThreadComment` posts; a `thread:comment` WS event appends a new comment live without refetch.
