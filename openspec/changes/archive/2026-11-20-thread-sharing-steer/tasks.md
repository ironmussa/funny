## 1. Data model — share level

- [x] 1.1 Add `level TEXT NOT NULL DEFAULT 'view'` to `thread_shares` in `packages/shared/src/db/schema.sqlite.ts` + `schema.pg.ts` (and the Drizzle `schema.ts`).
- [x] 1.2 Add a new numbered migration in `packages/shared/src/db/migrate.ts` using the existing `addColumn` helper (duplicate-column-safe). — `065_thread_shares_level` in `packages/server/src/db/migrate.ts`.
- [x] 1.3 Extend `thread-share-repository.ts`: persist `level` on insert (default `view`); add `getShareLevel(threadId, userId): 'view' | 'steer' | null`.
- [x] 1.4 Test: a grant inserted without an explicit level reads back as `view`; a `steer` grant reads back as `steer`.

## 2. Server — per-action authorization (allow-list)

- [x] 2.1 Add an `owner OR steer` gate in front of `POST /:id/message` in `packages/server/src/routes/threads.ts` (before `proxyToRunner`); 404 otherwise. — `requireThreadSteer` middleware.
- [x] 2.2 Split the git gate in `packages/server/src/index.ts`: allow `GET /api/git/:id/{status,diff,log,graph-log,commit/*}` for a `steer` sharee; keep all other git routes owner-only.
- [x] 2.3 Confirm the other proxied routes have an explicit owner check — added `requireThreadOwner` to `/upload`, `/stop`, `/approve-tool`, `/convert-to-worktree`, `/rewind`, `tool-calls` (fork* were already owner-gated).
- [x] 2.4 Test (security-critical): steer sharee reaches read git + (gate) `/message`; view sharee 404 on both; writes stay owner-only — covered in `thread-access.test.ts` (13 tests). Full route-level proxy test tracked in 7.1.

## 3. Server — runner resolution delegation (the crossing)

- [x] 3.1 Authorized-sharee resolution path. **Implemented at the proxy layer instead of `runner-resolver.ts`**: `proxyToRunner` reads the already-authorized `c.get('thread')` and, when the requester is not the owner, resolves by `thread.userId` (owner). This keeps `runner-resolver` strict/untouched and puts the delegation where the authz context lives. Never falls back to a third user's runner.
- [x] 3.2 In-code comment marks the single intentional exception to "Runner Isolation (CRITICAL)" in `proxy.ts`, referencing this change + CLAUDE.md.
- [x] 3.3 Audit record on every delegated resolution: `share.steer_delegation` action (`lib/audit.ts`) with actorId (sharee), ownerId, threadId, method, path.
- [x] 3.4 Git-read path covered by the SAME proxy delegation — read GETs pass through `requireThreadSteer` → set `thread` → `proxyToRunner` delegates. No separate code path needed.
- [x] 3.5 Test (`proxy-steer-delegation.test.ts`): steer sharee `/message` resolves to the OWNER id (audit fires); owner resolves to self; no loaded thread ⇒ no delegation. Isolation holds for non-gated routes (they never set `thread`).

## 4. Forwarded identity — signed share level

- [x] 4.1 Extended `forwarded-identity.ts` with optional `shareLevel`/`onBehalfOfThread`; canonicalize APPENDS them only when present → non-shared traffic keeps the exact legacy string (zero back-compat risk). New header consts `SHARE_LEVEL_HEADER`/`ON_BEHALF_OF_THREAD_HEADER`.
- [x] 4.2 Server proxy sets + signs the claim ONLY on a steer delegation (requester ≠ owner, thread already authorized by `requireThreadSteer`). userId stays the sharee (attribution).
- [x] 4.3 Contract test (`forwarded-identity.test.ts`): round-trips the claim; legacy-string equivalence; claim bound to signature (re-point thread id ⇒ fail; strip claim ⇒ fail).

## 5. Runtime — trust the sharee against the share

- [x] 5.1 Runtime `auth.ts` lifts the signed claim into context (`shareLevel`/`onBehalfOfThread`, added to `HonoEnv`); `requireThread` honors a verified steer grant (`isSteerGrantFor`). `/message` handler passes `steerFromContext(c)`.
- [x] 5.2 Runtime git-read handlers (`status`, all `diff/*`, `log`/`graph-log`/`commit/*`) pass the steer claim through `requireThread`/`requireThreadCwd`; cwd + project path resolve off the OWNER (`pathUserId`), GH_TOKEN off the sharee (→ none, never the owner's).
- [x] 5.3 N/A as written — runtime messages have NO per-message author column (attribution is thread-level); the steering actor is recorded in the server audit log (`share.steer_delegation`). Follow-up is persisted as a normal `role:'user'` message.
- [x] 5.4 Test (`route-helpers.test.ts`, 19 pass): steer sharee authorized for the matching thread; rejected for a different thread / a `view` claim; cwd resolves to the OWNER path, not the sharee. Non-allow-listed routes never receive the claim (server never signs it for them).

## 6. Client — steer UI

- [x] 6.5 Plumbed `level` end-to-end: `ShareLevel` + `ThreadShareGrant.level` in `client/src/lib/api/threads.ts`; `shareThread(threadId, userId, level)`; server `POST /:id/shares` accepts + validates `level` and `GET /:id/shares` returns it.
- [x] 6.1 Added steer-aware predicates `canSteerShare` / `canViewGitShare` in `thread-variant.ts`, backed by a NEW server field: `GET /threads/:id` now returns `viewerShareLevel` (owner→null, sharee→'view'|'steer'); added `Thread.viewerShareLevel?` to the shared type. Tested (`thread-variant.test.ts`, 5 new cases, 20 pass).
- [x] 6.2 `ThreadChatView`: the read-only notice now shows ONLY for a non-steer sharee; a `steer` sharee gets the `PromptInput` (`readOnlyShare = isReadOnlyShare(...) && !canSteerShare(...)`).
- [x] 6.3 Review/git panel for a steer sharee is now READ-ONLY end-to-end:
  - VISIBILITY: `ProjectHeader.activeThreadCanShowGit` gates on a fail-open share check → a `view` sharee can't open the panel; a `steer` sharee gets it.
  - WRITE-HIDING: added a `viewerReadOnly` flag (computed from auth + thread owner) in BOTH render paths — `ReviewPaneStateContext` (dockview `ChangesPanel`) and the legacy `ReviewPane.tsx` — threaded as `readOnly` into `ChangesToolbar` (collapses to just Refresh), `CommitDraftPanel` (returns null), and `ChangesFilesPanel` (per-file + per-folder stage/unstage/revert/discard/ignore items hidden). Read-only items (refresh, open, copy-path, diffs) stay. Git writes remain owner-only server-side as the backstop. Verified: `bun run build` green, typecheck 0 new, 20 client tests pass. (Minor follow-up: StashTab drop/apply is a secondary write surface still server-guarded but not UI-hidden.)
- [x] 6.4 `ShareThreadButton`: added a `view`/`steer` segmented picker (applied to the next member added, with a description line) + each grant row now shows its level via `levelLabel(s.level)`. Wired to `shareThread(threadId, userId, level)`.

## 7. Verification & docs

- [x] 7.1 Allow-list regression covered at the unit/middleware layer: `thread-access.test.ts` (steer reaches `/message`-gate + git read; view/stranger 404; git writes owner-only) + `proxy-steer-delegation.test.ts` (crossing resolves to owner, audited) + `route-helpers.test.ts` (runtime authz). NOTE: a full HTTP route-level e2e through the runtime test-app is blocked by unrelated WIP breakage in the working tree (see gotcha) — revisit once that lands.
- [x] 7.2 `bun run typecheck` ✓ no new errors (client 0); 57 tests pass (38 bun + 19 vitest) across the affected suites.
- [x] 7.3 Documented the audited runner-isolation exception in root `CLAUDE.md` (Runner Isolation CRITICAL section) — the 4 conditions that make the steer crossing safe.
