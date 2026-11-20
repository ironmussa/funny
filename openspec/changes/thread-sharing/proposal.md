## Why

Today a thread is permanently private to the one user who created it. The access
check is a single line repeated ~12 times across `routes/threads.ts`:

```
if (!thread || thread.userId !== userId) return 404
```

There is no way for a teammate to follow what an agent is doing on someone else's
thread, leave a note, or even glance at the result — even though projects are
already shareable (`project_members` with owner/admin/member roles, per-user
`localPath`), threads in an org are already listed cross-user, the full transcript
already lives in the server DB, and threads already support comments
(`thread_comments`). The only thing missing is the deliberate act of one user
**inviting a specific teammate into one thread**.

We want a thread owner to share a single thread with a specific person in their
organization, hand them a link, and — when that person opens it — see their avatar
appear live alongside anyone else watching. The invited person can read everything
and leave comments, but cannot drive the agent, touch git, or run anything: the
agent stays bound to the owner's runner and credentials, so sharing never crosses
the runner trust boundary.

## What Changes

- **New per-thread share grant (identity-gated).** An owner shares a thread with a
  specific user in their organization. This creates a `thread_shares` row keyed on
  `(threadId, sharedWithUserId)`. The "link" the owner copies is just a deep link
  to `/threads/:id` — it is **not** a capability token. Access is decided by
  identity at open time: the granted user gets in, everyone else gets the existing
  `404 Thread not found`. Sharing targets are limited to members of an organization
  the owner belongs to (a member picker, not a free-text email).
- **The access gate widens for read, stays closed for mutation.** This change
  builds on `thread-access-middleware` (a prerequisite, landed first), which already
  centralized the per-thread check into `requireThreadView` / `requireThreadOwner`
  with `canViewThread` / `isThreadOwner` predicates. `thread-sharing` only **widens
  the single `canViewThread` predicate** from "owner" to "owner OR has an active
  share", in one module. Read + comment routes (already on `requireThreadView`)
  thereby admit sharees; mutation/lifecycle/fork/rewind/git routes (on
  `requireThreadOwner`) stay strictly owner-only with no edit. Because the policy
  lives in one place, there is no risk of a missed mutation site leaking control.
- **Sharees can comment, not command.** A shared viewer may `POST
  /:id/comments`. Comments are `source: 'user'` annotations in `thread_comments`
  that are never injected into the agent prompt, so this is a pure server-side DB
  write that does not reach the owner's runner. Everything that would influence the
  agent remains owner-only.
- **Live stream reaches sharees via a per-thread WS room.** Today the runner→browser
  relay emits only to `user:${ownerId}`. We add a `thread:${id}` Socket.IO room that
  the owner and any sharee join **after** passing `canViewThread`. In-thread agent
  events (messages, tool calls) and presence are emitted to that room; cross-thread
  sidebar events (status/cost/new-thread) keep flowing through `user:${ownerId}`.
- **"Shared with me" is a new top-level nav bucket.** Threads shared to the current
  user surface in a dedicated cross-project feed, a sibling of the existing
  **Activity** and **Projects** buckets (reusing the `ActivityPane` / `AllThreadsView`
  feed pattern) — not buried inside per-project lists. Backed by
  `listThreadsSharedWithUser`.
- **Presence: live avatars of who is watching.** Joining a thread broadcasts
  `presence:join { threadId, user: { id, name, image } }` to the room; disconnect or
  navigation broadcasts `presence:leave`. The `ThreadView` header renders a live
  avatar stack of current viewers (excluding self), sourced from `users.image`
  (already populated by Better Auth). Presence is scoped to the shared thread only —
  not project-wide.
- **Revocation.** The owner can un-share. `DELETE /:id/shares/:userId` removes the
  grant, force-removes that user's sockets from the `thread:${id}` room, and emits a
  revoke event so the open tab drops back to a 404/empty state.

Out of scope (explicit, deferred): public/org-wide "anyone with the link" sharing
(this change is strictly identity-gated 1:1 grants — an `org:*` grant is a trivial
follow-up), letting a sharee send agent input or take over execution (no shared
control / handoff), project-level presence (avatars for "who is in the project"),
and email/external (non-org) sharing.

**Prerequisite:** `thread-access-middleware` must land first. It centralizes the
17-times-duplicated ownership check into `requireThreadView` / `requireThreadOwner`,
giving this change a single `canViewThread` predicate to widen instead of ~14
scattered edits.

## Capabilities

### New Capabilities

- `thread-sharing`: a thread owner grants a specific organization member read +
  comment access to a single thread. Covers the identity-gated share grant model
  and its lifecycle (create / list / revoke), the org-scoped share-target
  constraint, the read-vs-mutate access split (sharee may read and comment, never
  drive the agent or git), the per-thread WS room that carries the live stream to
  sharees, live presence (join/leave avatars scoped to the thread), and revocation
  semantics (grant removal evicts the viewer's socket and invalidates their access).

### Modified Capabilities

- `thread-access-control` (introduced by `thread-access-middleware`): the read access
  class widens from "owner only" to "owner OR holder of an active share grant". The
  owner-only class (mutation/git/share-admin) is unchanged. The existence-hiding `404`
  semantics are preserved.

## Impact

- **Shared:**
  - `packages/shared/src/db/schema.sqlite.ts` + `schema.pg.ts` — new
    `thread_shares` table (`threadId`, `sharedWithUserId`, `sharedByUserId`,
    `createdAt`; PK `(threadId, sharedWithUserId)`).
  - `packages/shared/src/repositories/thread-share-repository.ts` — new repo
    (`createShare`, `listSharesForThread`, `listThreadsSharedWithUser`,
    `hasShare`, `deleteShare`), mirroring the `comment-repository.ts` factory
    shape.
  - `packages/shared/src/types/thread.ts` — surface `sharedWith` / `sharedBy`
    on the thread/list payloads where the client needs them.
- **Server:**
  - `packages/server/src/db/migrate.ts` — `thread_shares` migration.
  - `packages/server/src/middleware/thread-access.ts` (from the prerequisite) —
    widen `canViewThread` to "owner OR `hasShare`". This is the single authorization
    edit; no route handler changes for the read/mutate split.
  - `packages/server/src/routes/threads.ts` — add `POST /:id/shares`,
    `GET /:id/shares`, `DELETE /:id/shares/:userId` (all `requireThreadOwner`);
    org-member validation for share targets; add a shared-with-me listing endpoint
    backed by `listThreadsSharedWithUser`.
  - `packages/server/src/services/ws-relay.ts` — `thread:${id}` room join/leave
    helpers, emit in-thread agent events + presence to the thread room, evict on
    revoke. Keep `user:${owner}` for cross-thread sidebar events.
  - `packages/server/src/services/socketio/*` — browser socket handler validates
    `canViewThread` before `socket.join('thread:'+id)`; presence broadcast on
    join/disconnect.
- **Client:**
  - `packages/client/src/components/thread/ThreadView.tsx` (header) — "Share"
    affordance (org-member picker + copy-link), live presence avatar stack.
  - `packages/client/src/hooks/use-ws.ts` — join the thread room on open, handle
    `presence:join` / `presence:leave` / share-revoked, and source the in-thread
    live stream from the thread room.
  - A read-only treatment for shared threads: hide/disable the prompt input, git
    review pane, start/stop, fork/rewind — reuse the existing variant predicates
    so divergence stays behind one helper (cf. `thread-variant.ts`). Comment
    input stays enabled.
  - A new **"Shared with me"** top-level nav bucket (sibling of Activity / Projects)
    rendering a cross-project feed via the `ActivityPane` / `AllThreadsView` pattern,
    plus its route in `App.tsx`.
  - `packages/client/src/lib/api/threads.ts` — share/unshare/list-shares calls.
- **Tests:** sharee can read + comment but is 404'd on every mutation/git route;
  revoke evicts and re-404s; non-org user cannot be granted; presence join/leave
  round-trips; identity-gated link denies a non-granted org member.
