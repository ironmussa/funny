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

### Runner isolation, and the one exception

**Requests are only ever routed to the runner belonging to the requesting user.** A user's runner is never substituted with another user's runner, even if that other runner is online — this is a hard tenant boundary, because a runner has access to that user's filesystem, git credentials, and environment. If a user's own runner is unavailable, the server returns `502`; it does not fail over to a different runner.

The **one intentional exception** is steer-share delegation: a thread shared at the `steer` level lets a non-owner sharee send follow-ups (`POST /:id/message`) and read git (`status`/`diff`/`log`) — on the **owner's** runner. This is allowed only because every one of these conditions holds simultaneously (confirmed in `packages/server/src/middleware/proxy.ts` and `packages/shared/src/auth/roles.ts`):

1. The crossing is gated by a **fixed allow-list** of routes — a steer sharee reaches nothing else (no stop/approve/upload/rewind/convert/fork/tool-calls, no git write, never the owner's GitHub token).
2. The crossing happens in `middleware/proxy.ts` only *after* thread-share authorization has already loaded and checked the grant, then resolves the runner by `thread.userId` (the owner) — never a blind fallback.
3. Every crossing emits an audit record (`share.steer_delegation`, per `packages/server/src/lib/audit.ts`).
4. The runtime re-authorizes the request via a **signed** `shareLevel` / `onBehalfOfThread` claim in the forwarded identity, because the runtime itself has no database to look up the grant (`packages/shared/src/auth/forwarded-identity.ts`).

Do not widen this allow-list or relax any of the four conditions without treating it as a security-sensitive change.
