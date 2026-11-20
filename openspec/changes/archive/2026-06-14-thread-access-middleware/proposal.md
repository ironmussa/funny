## Why

The per-thread authorization check is copy-pasted **17 times** in
`packages/server/src/routes/threads.ts`:

```
if (!thread || thread.userId !== userId) return c.json({ error: 'Thread not found' }, 404);
```

Each occurrence re-fetches the thread and re-applies the same ownership rule inline.
This is more than a DRY smell — it is a latent security hazard. The upcoming
`thread-sharing` change has to split this single rule into two (read routes widen to
"owner or shared-with"; mutation/git routes stay owner-only). Editing ~14 scattered,
identical lines by hand is exactly the kind of change where one missed site slips
through — and a missed **mutation** site would let a non-owner drive another user's
agent or git, breaching the runner trust boundary.

Centralizing the rule **before** any sharing logic exists makes the access policy
auditable in one place and turns "add sharing" into a one-predicate change instead of
a 14-site edit. This change is a pure refactor: identical responses, identical 404
existence-hiding, fully covered by the existing route tests.

## What Changes

- **Two Hono middlewares** in a new
  `packages/server/src/middleware/thread-access.ts`:
  - `requireThreadView` — resolves the thread, authorizes the requester for **read**
    access, stashes the loaded thread on the request context (`c.set('thread', ...)`),
    and returns `404 Thread not found` when the thread is missing **or** the requester
    is not authorized. Today "read access" == ownership; `thread-sharing` will widen
    this one predicate.
  - `requireThreadOwner` — same shape but authorizes **owner-only** access, for
    mutation, lifecycle, fork/rewind, share-admin, and git routes.
- **Routes declare their access class.** Each thread route is mounted with the
  appropriate middleware, so the read-vs-mutate boundary is visible in the route table
  rather than buried in handler bodies.
- **Handlers read `c.get('thread')`** instead of re-fetching and re-checking. The ~17
  inline `getThread` + `userId !== userId` blocks are removed.
- **No behavior change.** Same status codes, same existence-hiding 404 (a thread that
  exists but isn't yours is indistinguishable from one that doesn't exist), same
  per-user scoping. Only the _location_ of the check moves.
- **One special case preserved.** The messages route currently uses
  `getThreadWithMessages` to fetch thread + messages in a single round-trip. The
  middleware resolves the thread up front; that handler either reuses the
  context thread and fetches only messages, or keeps its combined fetch and relies on
  the middleware purely for the authorization decision. Whichever path is taken must
  not add a redundant query on the hot read path.

## Capabilities

### New Capabilities

- `thread-access-control`: centralized authorization for per-thread routes. Defines
  that every thread-scoped route resolves the thread and authorizes the requester
  before the handler runs, that read routes and owner-only routes are distinct
  classes, and that unauthorized or nonexistent threads are indistinguishable
  (`404`). This capability is the seam `thread-sharing` later modifies (widening the
  read class to "owner or shared-with").

## Impact

- **Server:**
  - `packages/server/src/middleware/thread-access.ts` — new file: `requireThreadView`,
    `requireThreadOwner`, and the `canViewThread` / `isThreadOwner` predicates they
    wrap. Wires `threadRepo.getThread` once and sets `c.set('thread', thread)`.
  - `packages/server/src/routes/threads.ts` — mount the middlewares per route; delete
    the 17 inline checks; handlers read `c.get('thread')`.
  - Git routes (`/api/git/:id/*`, wherever mounted in server/runtime proxy) — apply
    `requireThreadOwner` so they stay owner-only by construction.
  - Hono context typing — declare `thread` on the context variables so `c.get('thread')`
    is typed.
- **Tests:**
  - Existing route tests must stay green unchanged (the refactor is behavior-preserving).
  - Add a focused middleware test: owner passes both; non-owner gets `404` from both;
    missing thread gets `404`; the loaded thread is available to the handler via context.
