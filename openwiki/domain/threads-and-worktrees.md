# Threads, worktrees, scratch threads, and sharing

A **thread** is one running conversation with a coding agent. This page covers the domain rules that make threads behave differently depending on mode, ownership, and sharing level. These rules are deliberately centralized behind a small number of predicate modules — do not scatter ad-hoc `if` checks for them elsewhere in the code.

## Thread modes

- **`local`** — the agent runs directly inside the project's working directory.
- **`worktree`** — a dedicated git worktree + branch is created for the thread (`packages/core/src/git/worktree.ts`), so parallel threads never collide on a checkout. This is the mechanism the whole product name leans on ("run coding agents in parallel across isolated git worktrees").

## Scratch threads

A **scratch thread** is a lightweight, projectless thread for throwaway work ("bounce ideas / try a regex / sketch code") — it reuses the same chat/tool-call/WebSocket pipeline as a normal thread but has no project, no git, and no worktree.

- **DB shape:** a `threads` row with `is_scratch = 1`; `project_id` is `NULL` (the TS type uses `projectId: string` with `''` as the boundary sentinel).
- **Working directory:** `~/.funny/scratch/<userId>/<threadId>/` on the runner, created lazily on first agent start and removed with `rm -rf` on thread delete.
- **Always `mode = 'local'`** — worktree mode is rejected for scratch threads with `400 scratch-thread-must-be-local`.
- **No git, ever** — `/api/git/:threadId/*` returns `400 git-not-allowed-for-scratch` for any scratch thread; the client hides the review pane, diff, commit, push, and PR affordances accordingly.
- **Per-user isolation** — each user only sees their own scratch threads; cross-user access returns `404`.

**Single source of truth — verified still present in the current tree:**

- **Runtime:** `packages/runtime/src/services/thread-context.ts` (plus a newer `thread-context-builder.ts`) exports `resolveThreadCwd(thread, project)`, `canDoGitOps(thread)`, `scratchPathFor(userId, threadId)`.
- **Client:** `packages/client/src/lib/thread-variant.ts` exports `isScratch(thread)`, `canDoGitOps(thread)`, `canShowPowerline(thread)`, `canConvertToWorktree(thread)`, `canFetchGitStatus(thread)`, `getThreadRoute(thread)`, `getSidebarBucket(thread)`.

When you find a new axis of divergence between scratch and normal threads, add a predicate to one of these two modules — not a call-site `if (thread.isScratch)`.

## Thread creation flow

Creating a thread spans the server and the runtime.

- **Server** (`packages/server/src/modules/threads/`) normalizes the request and enforces scratch invariants before any I/O. Errors are checked in this order: `scratch-thread-cannot-have-project`, then `scratch-thread-must-be-local`, then `projectId is required`. The server then resolves **the authenticated user's own** runner. There is never a fallback to another user's runner. It forwards the payload with a signed identity (unknown fields pass through unchanged), registers the returned thread in the central DB, and caches the thread→runner route. The runtime's branch value wins over the request's branch. The legacy `__default__` runner skips registration and caching.
- **Runtime** (`packages/runtime/src/services/thread-service/`) does the actual creation: DB row via the data channel, worktree/branch, and agent start.

Remote creation and registration are not atomic. If the registry write fails after the runner succeeds, the request returns `502 Thread creation failed` and is not retried. The use case is `makeCreateThread` (public API in `modules/threads/index.ts`). Production wiring is `composeCreateThread` in `modules/threads/composition.ts`. See the [architecture overview](../architecture/overview.md#server-feature-module-pilot-modulesthreads).

## Thread fork flow

`POST /api/threads/:id/fork` and `POST /api/threads/:id/fork-and-rewind` run the same server sequence as creation, as the `makeForkThread` use case in `packages/server/src/modules/threads/` (wired by `composeForkThread`):

1. `requireThreadOwner` loads the source thread for the authenticated owner. Another user's thread is a `404`; nothing reaches a runner.
2. The server resolves **the owner's own** runner through the source's project. There is never a fallback to another user's runner. No online runner is `502 No online runner found for this project`.
3. The request body is forwarded to the runner **byte-for-byte**, with a signed identity. The server does not parse or validate it; the runtime's `forkThreadSchema` / `forkAndRewindSchema` do.
4. A non-OK runner response is returned with the runner's status. The two variants format the error differently and the client depends on both: `fork` returns `{ error: <runner error message> }`; `fork-and-rewind` returns `{ error: "Runner error: <raw body>" }`.
5. The new thread is read from the runner's response — top-level for `fork`, under `thread` for `fork-and-rewind` — and, when it has an id and the runner is not `__default__`, registered in the central DB and cached for routing. Registration fields (`title`, `model`, `mode`, `branch`) come from the response, `projectId` from the source, and `isScratch` is always `false` (preserved legacy behavior; see the open question in `openspec/changes/modularize-thread-fork/design.md`).
6. The runner's full body is returned with `201`. A `null` body is returned as `201 null` and nothing is registered.

Remote fork and registration are not atomic. Any failure after the runner call (malformed JSON, registry, cache) is `502 Thread fork failed` or `502 Thread fork-and-rewind failed` and is not retried. The route tests in `packages/server/src/__tests__/routes/threads-runner-proxy.test.ts` pin this contract per variant.

## Team sharing: roles, capabilities, and the "steer" exception

funny has two deployment shapes: **local** (everything on one machine) and **team** (a central server coordinates multiple users, each with their own runner). In team mode, thread owners can share a thread with project members. `packages/shared/src/auth/roles.ts` defines the canonical model:

```text
Role rank:      viewer (0)  <  commenter (1)  <  contributor (2)  <  admin  <  owner
Capability:      view          comment            steer
UI label:       "Viewer"      "Commenter"         "Editor"
```

- **`view`** — read the thread and existing comments.
- **`comment`** — read + post comments.
- **`steer`** — read + comment + send follow-up messages to the agent (displayed to end users as **Editor**). Git write actions (commit, push, PR creation, stage, destructive ops) always stay owner-only, regardless of share level.

### Project access

Threads are private; projects are shared workspaces. The unified authorizer (`packages/shared/src/auth/authorizer.ts`) gives a user a role on a project when they are:

| Who | Role | Can |
|---|---|---|
| The creator | `owner` | everything, including delete |
| A collaborator (`project_members`, role `admin`) | `admin` | view + `manage` (members, startup commands, project settings) |
| A collaborator (role `member`) | `contributor` | view |
| A member of an org the project is shared with (`team_projects`) | `viewer` | view |

Org sharing never reaches the project's threads — those still need an explicit thread grant. Server routes declare the capability they need with `requireProjectAccess(capability)` (`packages/server/src/middleware/project-access.ts`, wired in `lib/server-authorizer.ts`); runtime routes use `requireProject` / `requireAccessibleProject` (`packages/runtime/src/utils/route-helpers.ts`, `routes/github/helpers.ts`). A caller with no role gets the same `404 Project not found` as for a missing id, so foreign projects stay invisible; a caller who can see the project but lacks the capability gets `403`. Runner settings (`project-runner-settings.ts`) stay owner-only, since they pin the owner's own runners.

### Runner isolation, and the one exception

**Requests are only ever routed to the runner belonging to the requesting user.** A user's runner is never substituted with another user's runner, even if that other runner is online — this is a hard tenant boundary, because a runner has access to that user's filesystem, git credentials, and environment. If a user's own runner is unavailable, the server returns `502`; it does not fail over to a different runner.

The **one intentional exception** is steer-share delegation: a thread shared at the `steer` level lets a non-owner sharee send follow-ups (`POST /:id/message`) and read git (`status`/`diff`/`log`) — on the **owner's** runner. This is allowed only because every one of these conditions holds simultaneously (confirmed in `packages/server/src/middleware/proxy.ts` and `packages/shared/src/auth/roles.ts`):

1. The crossing is gated by a **fixed allow-list** of routes — a steer sharee reaches nothing else (no stop/approve/upload/rewind/convert/fork/tool-calls, no git write, never the owner's GitHub token).
2. The crossing happens in `middleware/proxy.ts` only _after_ thread-share authorization has already loaded and checked the grant, then resolves the runner by `thread.userId` (the owner) — never a blind fallback.
3. Every crossing emits an audit record (`share.steer_delegation`, per `packages/server/src/lib/audit.ts`).
4. The runtime re-authorizes the request via a **signed** `shareLevel` / `onBehalfOfThread` claim in the forwarded identity, because the runtime itself has no database to look up the grant (`packages/shared/src/auth/forwarded-identity.ts`).

Do not widen this allow-list or relax any of the four conditions without treating it as a security-sensitive change.

### Fork ownership evidence

Both fork variants retain owner middleware and reuse its loaded thread. The shared
handler copies and freezes the authenticated actor and authoritative source, names
them inside `withForkInputs`, and obtains `ThreadOwnedBy` from the pure checker.
The fork command requires evidence for those exact named values. Failed issuance
returns `404 Thread not found` before runner resolution or other effects, with no
additional thread fetch. View and steer grants do not grant fork ownership.

The use case unwraps checked values only when invoking its trusted adapters.
Evidence never enters request bodies, signed identity, HTTP/gRPC messages,
registration or routing caches. The proof protects typed application callers;
runtime authentication, signed-identity verification and remote validation remain
necessary. Request-local snapshots do not solve ownership races or remote fork /
registration atomicity.
