# Design — thread-sharing

## Context

- **Ownership gate is one repeated line.** `routes/threads.ts` guards every thread
  route with `if (!thread || thread.userId !== userId) return 404`. It appears on
  the detail, messages, events, comments, fork, rewind, follow-up and lifecycle
  routes. This is the single seam sharing plugs into.
- **Projects are already shared.** `project_members(projectId, userId, role,
  localPath)` with `role ∈ owner|admin|member`, `isTeamProject`, and
  `teamProjects(projectId → teamId)`. Each member runs threads on **their own**
  runner against **their own** `localPath`.
- **Threads in an org are already listed cross-user.** `listThreads` filters by
  `projectId ∈ org` (not by `userId`) in org mode (`thread-repository.ts:129`).
  The static transcript is therefore already org-visible; only the _live_ stream
  and the _deliberate per-thread invite_ are missing.
- **Comments already exist.** `thread_comments(threadId, userId, source, content)`,
  `Thread.commentCount`, and `GET/POST/DELETE /:id/comments`. Comments are written
  with `source: 'user'` and are **never** injected into the agent prompt — they are
  human annotations only.
- **The WS relay is per-user.** `ws-relay.ts` routes runner events to the
  `user:${ownerId}` Socket.IO room (`relayToUser`). There is no per-thread room and
  no presence channel today.
- **Avatars exist.** Better Auth `users` table already has `image`, `name`,
  `username` — enough for a presence avatar stack with no new identity work.

## Goals / Non-goals

**Goals.** One owner invites one specific org member into one thread; the invitee
reads everything and can comment; live presence shows who is watching; the owner
can revoke; nothing the invitee does reaches the owner's runner.

**Non-goals.** Shared _control_ (sharee sending agent input), handoff (moving a
thread to another runner), org-wide "anyone with the link" access, project-level
presence, and non-org sharing. All deferred.

## Decisions

### D1 — The link is identity-gated, not a capability token

A share is a row `thread_shares(threadId, sharedWithUserId, sharedByUserId,
createdAt)` with PK `(threadId, sharedWithUserId)`. The URL the owner copies is the
ordinary deep link `/threads/:id`; it carries no secret. On open, access is decided
by the requesting user's identity against the grant table.

- _Why not a capability link (token in URL):_ a leaked link would let anyone in,
  which contradicts the requirement that "the other person could not enter." Identity
  gating means a forwarded link is inert for anyone without a grant.
- _Trade-off:_ the invitee must already have a funny account in the org. That is
  exactly the intended scope (share with a specific teammate), so it is a feature,
  not a limitation. Inviting a brand-new person is a separate org-invite flow that
  already exists (`invite_links`).

### D2 — Org-scoped share targets

`sharedWithUserId` MUST be a member of an organization the owner belongs to. The
share UI is a picker populated from org membership, and `POST /:id/shares` re-checks
membership server-side (never trust the client list). Sharing with a non-org user is
rejected `400`.

### D3 — Two predicates: read+comment vs owner-only

The prerequisite change `thread-access-middleware` already replaced the 17 inline
checks with two middlewares (`requireThreadView` / `requireThreadOwner`) wrapping two
predicates. `thread-sharing` only widens one of them — `canViewThread`:

```
canViewThread(thread, userId)  = thread.userId === userId  OR  hasShare(thread.id, userId)
isThreadOwner(thread, userId)  = thread.userId === userId
```

| Route class  | Examples                                                        | Predicate       |
| ------------ | --------------------------------------------------------------- | --------------- |
| Read         | `GET /:id`, `/:id/messages`, `/:id/events`, `GET /:id/comments` | `canViewThread` |
| Comment      | `POST /:id/comments`                                            | `canViewThread` |
| Mutate agent | start, stop, follow-up, fork, rewind, model change              | `isThreadOwner` |
| Git          | all `/api/git/:id/*`                                            | `isThreadOwner` |
| Share admin  | `POST/GET/DELETE /:id/shares`                                   | `isThreadOwner` |

This is the crux of staying inside the trust boundary: a sharee can read and annotate
(server DB only), but **every path that reaches the owner's runner or git stays
owner-only**. Comment-create is safe under `canViewThread` precisely because comments
are not fed to the agent (see Context). Because the rule lives in one predicate,
widening read access cannot accidentally widen mutation access — the failure mode of
hand-editing 14 sites is structurally eliminated.

### D4 — Per-thread WS room for the live stream + presence

Add a `thread:${id}` Socket.IO room.

- A browser opening a viewable thread calls a join handler; the server validates
  `canViewThread` and only then runs `socket.join('thread:'+id)`. No gate bypass:
  a non-sharee can never receive thread events because it can never join the room.
- **In-thread agent events** (assistant messages, tool calls, result) are emitted to
  `thread:${id}`. **Cross-thread sidebar events** (status badge, cost, new-thread)
  keep going to `user:${ownerId}` so the owner's sidebar is unaffected.
- **Presence** is a property of room membership: on join, broadcast
  `presence:join { threadId, user: { id, name, image } }`; on `disconnect` or an
  explicit leave (navigating away), broadcast `presence:leave { threadId, userId }`.
  The client keeps a per-thread viewer set and renders an avatar stack (self
  excluded).

**Double-delivery note.** The owner is the producer's target (`user:${owner}`) _and_
a viewer (`thread:${id}`). To avoid delivering each in-thread event twice to the
owner's socket, the in-thread live stream is sourced **only** from the thread room on
the client; the owner joins `thread:${id}` when viewing and the relay sends in-thread
events to the thread room exclusively (not also to the user room). The user room
carries only the cross-thread/sidebar event classes. This cleanly partitions the two
streams by event category rather than deduping at the socket layer.

### D5 — Revocation evicts immediately

`DELETE /:id/shares/:userId` deletes the grant, looks up that user's sockets in
`thread:${id}`, force-leaves them, and emits `thread:share-revoked { threadId }` to
them. The client, on receiving it (or on the next failed fetch), drops the thread
from its shared list and shows the standard not-found/empty state. Because access is
checked per request against the grant table, even a missed eviction fails closed on
the next read.

### D6 — Client read-only variant

Shared (non-owner) threads render in a read-only mode: prompt input, start/stop, git
review pane, fork/rewind, and model/permission selectors are hidden or disabled; the
comment input stays enabled. This divergence goes behind the existing thread-variant
predicate module (`packages/client/src/lib/thread-variant.ts`) — add e.g.
`isReadOnlyShare(thread)` rather than sprinkling `if (sharedWithMe)` at call sites,
consistent with how scratch-thread divergence is consolidated.

## Data model

```
thread_shares
  threadId         text  FK threads.id  (cascade delete)
  sharedWithUserId text  (the invited org member)
  sharedByUserId   text  (the owner who granted; for audit / "shared by X")
  createdAt        text  ISO
  PRIMARY KEY (threadId, sharedWithUserId)
```

Cascade on thread delete drops grants automatically. No token column — the grant
_is_ the credential.

### D7 — "Shared with me" is a top-level nav bucket, not a sidebar sub-list

Shared threads surface in a dedicated cross-project feed that is a **sibling of the
existing Activity and Projects buckets**, reusing the `ActivityPane` /
`AllThreadsView` rendering and a new route in `App.tsx`. Backed by
`listThreadsSharedWithUser`. This keeps shared threads discoverable independently of
the link (re-finding does not depend on having saved the URL) and matches the user's
mental model of top-level views rather than burying them in per-project lists.

### D8 — Socket.IO transport now, but presence uses an awareness-shaped state model (migration-ready)

**Framing correction.** Presence is _not_ exclusive to Socket.IO: Yjs ships an
**Awareness** protocol (ephemeral, non-persisted per-client state — cursor, name,
online) that is the canonical way to do presence _when you already run a Y.Doc_. The
real decision axis is therefore **not presence** (both stacks do it) but whether
funny will have **concurrent co-editing of shared mutable state** (same prompt/canvas
to many hands). That is currently **uncertain** — possible, not committed.

**Decision (hybrid).** Given the uncertainty, presence runs over the **existing
Socket.IO transport now**, but is modeled in the **shape of `y-protocols/awareness`**
so a later migration to full Yjs is cheap. Concretely, presence is an ephemeral map
keyed by a per-connection `clientID` → `{ user: { id, name, image }, cursor? }`, with:
local-origin state set + diff broadcast, and timeout/removal on disconnect. These three
properties map 1:1 onto both Socket.IO (today) and a Yjs awareness provider (later). We
do **not** stand up a `y-websocket` server or introduce a `Y.Doc`; awareness updates
ride the `thread:${id}` room.

**What this buys / costs.** Buys: a standard presence data-model that plugs into a real
Yjs provider with a transport swap if co-editing ever lands — no rewrite, no two
competing presence systems. Costs: a slightly richer state model than a bare
join/leave broadcast (and optionally one small dep, `y-protocols`). Low regret because
presence has **no persisted state to migrate** — only the transport changes.

**Still excluded.** No SaaS multiplayer (Liveblocks/Ably): routing thread content and
presence through a third party with a second auth system contradicts funny's
runner-isolation / per-user trust model. If co-editing is ever committed, adopt
**self-hosted Yjs** — never a SaaS. Decision rule: broadcast → Socket.IO in-house;
concurrent shared-state mutation → self-hosted Yjs, with presence folded into its
Awareness at that point.

The live agent stream stays a plain server→room fan-out (it is not awareness state;
it is server-produced events broadcast to viewers) — unchanged by this decision.

### D9 — Comments live in a dedicated docked panel with its own header icon (clone of the file manager)

The original task list (6.3) said "keep the comment input enabled" as if a comment UI
already existed. It does not — only the backend (`thread_comments`, the repo, and
`GET/POST/DELETE /:id/comments`) and the client API methods
(`getThreadComments`/`createThreadComment`/`deleteThreadComment`) exist; nothing on the
client renders them. The read-only footer currently _promises_ commenting it cannot
deliver. This decision adds the missing surface.

**Shape.** Comments are a **flat, thread-level discussion feed**, not inline
per-message annotations: `thread_comments(id, threadId, userId, source, content,
createdAt)` has **no `messageId`/anchor column**. A side panel that lists comments and
takes new ones is therefore the correct form; inline bubbles would require an anchor
the schema does not have.

**Placement — mirror the file manager, not a review sub-tab, not an overlay.** The
project file manager opens the right dock as a **single header-less panel** via
`rightPaneTab: 'files'` (toggled by the `FolderTree` header icon in `ProjectHeader`),
_beside_ the git tabs (Changes/History/Stash/PRs/Issues) but not as one of them.
Comments adopt this exact pattern:

- New `RightPaneTab` value `'comments'` in `ui-store.ts`, rendered by `App.tsx`'s
  `singleRightPanel` branch (`rightPaneTab === 'comments' → <CommentsPane/>`), a sibling
  of `'files'`/`'activity'` — **not** a dockview sub-tab under `'review'`, and **not** a
  `Sheet` overlay.
- A new owner+sharee header icon (💬, clone of `header-toggle-project-files`) that
  toggles `setCommentsPaneOpen` the same way the files icon toggles `setFilesPaneOpen`.
  Badge = `Thread.commentCount` (already on the type).

**Visibility gate differs from files.** The files icon is gated on git context
(`projectId && !scratch`). The comments icon must be visible to **any viewer of the
thread — owner OR sharee** — and must work where there is no git (shared/scratch
threads, exactly the case files cannot serve). This goes behind a new
`thread-variant.ts` predicate `canShowComments(thread)` rather than an inline check, per
the project's predicate-consolidation rule.

**Footer reconciliation.** With the input living in the panel, the read-only-share
footer notice changes from "You can comment, but only the owner can send messages" (a
promise with no UI) to a pointer: "Read-only — open 💬 Comments to leave a note."

**Live updates (gap surfaced).** New comments are **not** broadcast over the
`thread:${id}` room today (D4 routes agent events + presence only). Without a broadcast,
a sharee's comment does not appear to the owner until a refetch. Decision: add a
`thread:comment` broadcast to the existing room (marginal cost — the room is already
stood up) so comment-create round-trips live to all viewers, consistent with the
"shared session" goal. The client appends on receipt and refetches on panel open as a
backstop.

## Open questions

- **Presence socket namespace.** Awareness-shaped presence rides the existing
  browser→server socket (decided in D8); the remaining detail is _which_ namespace —
  `socketio/browser-namespace` vs the main relay namespace — to best reuse the
  socket's existing auth. Resolvable at implementation time.
- **`y-protocols` dependency, yes/no.** Whether to import the actual
  `y-protocols/awareness` `Awareness` class (and bridge its encoder to the Socket.IO
  transport) or hand-roll an awareness-_shaped_ map. The former is more directly
  migratable; the latter avoids the dep. Lean hand-rolled if the bridge is awkward,
  since the data-model shape (not the library) is what makes migration cheap.
