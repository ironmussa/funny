## Context

A thread runs on the **owner's runner**: their local folder, the live agent process, and their GitHub token. The central server proxies every agent/git request to a runner resolved by `resolveRunner(path, query, requesterUserId)` — strictly scoped to the requester (`packages/server/src/services/runner-resolver.ts`). That isolation is also the _de facto_ authorization gate: the proxied thread routes (`POST /:id/message`, `/stop`, `/approve-tool`, `/upload`, `/rewind`, `/convert-to-worktree`, `PATCH /:id/tool-calls/:tc`) have **no per-action owner check** — they call `proxyToRunner` directly (`routes/threads.ts:810+`). Today a sharee is stopped only because the resolver finds no runner for them → 502.

The existing `thread-sharing` change delivered view + comment + presence with a binary grant (`thread_shares`, `hasShare`). Comments are deliberately `source:'user'` and never injected into the agent prompt — that is what keeps commenting inside the trust boundary. Steering breaks exactly that property: it injects a prompt into an agent running on someone else's machine.

This change adds a `steer` level that lets a collaborator (a) send follow-ups and (b) read git state — and nothing else.

## Goals / Non-Goals

**Goals:**

- A second, fixed share level `steer` = `view` + git read-only + follow-ups.
- An **explicit per-action allow-list** so crossing runner isolation does not silently widen the other six proxied routes.
- A documented, audited delegation: a `steer` sharee's allow-listed request resolves to the **owner's** runner.
- The runtime authorizes the sharee against the **share grant**, not just ownership; follow-ups are attributed to the sharee.
- Back-compat: existing grants behave as `view`.

**Non-Goals:**

- No git **write** for sharees (commit/push/PR/stage/stash) and no use of the owner's GitHub token.
- No `stop` / `approve-tool` / `upload` / `rewind` / `convert-to-worktree` / `fork` / `tool-call` edits / thread-admin for sharees — those stay owner-only and keep working as today for the owner.
- No granular per-capability flags (decided: two fixed levels only).
- No co-editing / shared-control CRDT semantics.

## Decisions

### D1 — Two fixed levels, not granular flags

Model `thread_shares.level TEXT` ∈ {`view`,`steer`}, default `view`. **Why over granular booleans** (`can_steer`, `can_view_git`, …): the user wants a UI a human can reason about ("can they nudge it or just watch?"), and the allow-list is small and fixed. Granular flags multiply the test matrix and the share-UI surface for no current benefit. A future split into flags stays open (level is just a coarser encoding).

### D2 — Explicit per-action allow-list at the server, decoupling isolation from authz

Add an authorization gate **in front of** `proxyToRunner` for `POST /:id/message` (owner OR `level==='steer'` → else 403), and split the git gate in `index.ts` so `status`/`diff`/`log` are reachable by a `steer` sharee while writes stay owner-only. **Why**: the moment runner resolution can reach the owner's runner for a sharee (D3), the implicit isolation gate disappears for _every_ proxied route at once. The allow-list must be positive and explicit so the other six routes still reject. A regression test per non-allow-listed route is mandatory. **Alternative rejected**: relying on the runtime alone to reject — that leaves the server forwarding dangerous requests and depends on the runtime being perfectly in sync.

### D3 — Resolve by `thread.ownerId` for authorized sharees (audited)

In `runner-resolver.ts`, when the requester is a `steer` sharee of the thread, resolve via `getRunnerForThread(threadId, thread.ownerId)` instead of the requester id. **Why**: the runner genuinely belongs to the owner; this is a _delegation_, not a blind cross-tenant fallback. It is the single, narrow exception to the "Runner Isolation (CRITICAL)" rule and MUST be: (a) gated by an authorization check that already passed (D2), (b) accompanied by an in-code comment pointing at this change, (c) audited via `lib/audit.ts` on every cross. **Alternative rejected**: a generic "resolve any runner assigned to the project" — that reintroduces the exact cross-tenant leak the strict resolver was built to prevent.

### D4 — Runtime trusts a signed `shareLevel` in the forwarded identity

The runtime must authorize an incoming `/message` whose `X-Forwarded-User` is a sharee (not the owner) — today it would reject as non-owner. **Decision: extend the HMAC-signed forwarded identity** (`packages/shared/src/auth/forwarded-identity.ts`, `signForwardedIdentity`) with an optional `shareLevel`/`onBehalfOfThread` claim the server sets only after it has verified the grant. The runtime trusts the signature (already the trust anchor for `X-Forwarded-User`) and enforces the allow-list locally. **Why over "runtime queries the DB"**: the runtime has **no database** (it proxies persistence to the server) — it cannot look up the share itself. Signing keeps the existing single trust anchor and avoids a new runtime→server authz round-trip. **Alternative rejected**: a separate unsigned header — forgeable by anyone holding the shared secret path; the whole point of the HMAC is to bind these claims.

### D5 — Sharee follow-ups attributed to the sharee

Persist the follow-up message with the sharee's userId and `source:'user'`. **Why**: the thread already mixes authors (owner + future sharees); attribution is needed for the audit trail and for presence/UX ("X sent a follow-up"). It never touches git identity (no writes), so there is no commit-attribution question.

## Risks / Trade-offs

- **[Crossing runner isolation widens blast radius]** → Mitigate with D2's positive allow-list + a regression test asserting each non-allow-listed route returns 403/404 for a `steer` sharee, plus the audit log (D3). Treat the allow-list as security-critical code.
- **[Signed-claim drift between server and runtime]** → Any mismatch between what the server signs and what the runtime verifies breaks HMAC (the existing code already warns about this for role). Keep the signed payload shape in one shared module and add a contract test.
- **[A steer sharee can waste/derail the owner's agent run]** → Accepted: steering is the feature. Bounded by: no stop/approve (sharee can't kill or unblock destructive tools), audit trail, and the owner can revoke instantly (existing `thread:share-revoked` + socket eviction).
- **[Git read still runs shell on the owner's machine]** → Low risk (read-only `git status/diff/log`), but it is real command execution; keep it limited to those three subcommands, never arbitrary git.
- **[Migration on a populated table]** → `level` is additive with a default; follow the existing `addColumn` migration pattern in `shared/db/migrate.ts` (which only swallows duplicate-column errors). Rollback = ignore the column (readers default to `view`).

## Migration Plan

1. Add `level` to `thread_shares` (schema + new numbered migration, default `'view'`). Back-compat verified by a test that an unset grant reads as `view`.
2. Ship server authz (D2) + resolver delegation (D3) + audit behind the allow-list — safe even before any `steer` grant exists (no grant ⇒ no behavior change).
3. Extend forwarded-identity signing (D4) and runtime authz together (contract test).
4. Client: expose the `view`/`steer` choice in the share UI; flip `isReadOnlyShare` to a steer-aware predicate.
5. Rollback: stop issuing `steer` grants; existing readers treat everything as `view`. The column can stay.

## Open Questions

- **Q1 — Does git-read need the same `getRunnerForThread(ownerId)` delegation as `/message`?** Almost certainly yes (git also runs on the owner's runner), so D3 should cover both paths, not just `/message`. Confirm during apply.
- **Q2 — Granularity of the git allow-list:** is splitting `gitRoutes` (status/diff/log vs the rest) cleanly doable at the `index.ts` gate by sub-path, or does it need a per-subroute middleware inside `packages/runtime/src/routes/git.ts`? Lean: gate at the server `index.ts` by path prefix to keep the runtime simple.
- **Q3 — Should the audit record live server-side only, or also surface to the owner in-thread** (e.g. a presence/event line "shared user sent a follow-up")? Out of scope unless trivially cheap via the existing thread-event fan-out.
