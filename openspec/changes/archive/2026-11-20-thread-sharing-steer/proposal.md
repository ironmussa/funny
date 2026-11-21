## Why

Sharing a running thread today is read-only (view + comment + presence). The thread physically lives on the **owner's runner** — owner's local folder, agent process, and GitHub token — and the runner-isolation boundary (`resolveRunner` scoped to the requester) doubles as the implicit authorization gate for every proxied route. A sharee cannot send follow-ups to steer the agent, nor see git state, because their request resolves to _their own_ (absent) runner and 502s. We want a collaborator to be able to **nudge the agent (follow-ups) and read git state** without ever touching the owner's credentials or driving destructive operations.

## What Changes

- **BREAKING (data model):** the binary `thread_shares` grant gains a `level` column with two fixed values: `view` (today's behavior) and `steer`. Existing rows default to `view` — no behavior change for current shares.
- A `steer` sharee gains exactly **4 new capabilities**, allow-listed explicitly:
  - `POST /api/threads/:id/message` — send a follow-up to the running agent.
  - `GET /api/git/:id/status`, `/diff`, `/log` — **read-only** git state.
- A `steer` sharee gains **nothing else**: no `stop`, `approve-tool`, `upload`, `rewind`, `convert-to-worktree`, `fork`, `tool-calls`, no git **write** (commit/push/PR/stage/stash), no thread admin, and never uses the owner's GitHub token. Those remain owner-only and continue to fall through to the existing 403/404.
- **Runner resolution crossing:** for an authorized `steer` sharee, the server resolves the runner by the **thread owner's** id instead of the requester's — a deliberate, audited delegation that is otherwise forbidden by the "Runner Isolation (CRITICAL)" rule. Every such cross is written to the audit log.
- **Runtime trust:** the runtime accepts `X-Forwarded-User = sharee` and authorizes `/message` + git-read against the **share grant**, not only thread ownership. The follow-up is persisted with the sharee's authorship (`source: 'user'`).
- **Client:** `isReadOnlyShare` splits into a "can steer" state — the sharee sees the `PromptInput` and a read-only git/review panel (commit/push/PR hidden).

## Capabilities

### New Capabilities

- `thread-share-steer`: the `steer` share level — its permission model, the explicit per-action allow-list (follow-up + git read-only), the audited runner-resolution delegation to the owner's runner, and the runtime-side trust of a forwarded sharee identity.

### Modified Capabilities

<!-- thread-sharing's requirements live in its own (un-archived) change, not in openspec/specs/. No archived capability spec changes here; this change layers on top. -->

## Impact

- **`packages/shared`** — `thread_shares` schema + new migration (`level` column, default `view`); `thread-share-repository.ts` gains `getShareLevel(threadId, userId)`; possibly `signForwardedIdentity` payload extended with `shareLevel` (`auth/forwarded-identity.ts`).
- **`packages/server`** — `routes/threads.ts` (`POST /:id/message` gains an owner-OR-steer gate before `proxyToRunner`); `index.ts` git gate split into read vs write; `services/runner-resolver.ts` owner-scoped resolution for sharees; `lib/audit.ts` delegation events.
- **`packages/runtime`** — `/message` + git-read handlers authorize against the share, not only ownership; sharee follow-up persistence.
- **`packages/client`** — `lib/thread-variant.ts` (`isReadOnlyShare` → steer-aware predicates); `ThreadChatView` / review panel gating; share UI exposes the `view`/`steer` choice.
- **Security boundary** — intentionally crosses runner isolation for a narrow, authorized, audited case. Requires explicit code comments referencing this change and regression tests proving non-allow-listed routes still 403/404 for a `steer` sharee.
- **Related:** layers on top of the in-progress `thread-sharing` change; does not alter its scope.
