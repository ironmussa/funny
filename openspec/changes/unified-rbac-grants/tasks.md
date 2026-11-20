## 1. Data model — unified grants table ✅ DONE

- [x] 1.1 Added `resource_grants` (composite PK `(subject_id, resource_type, resource_id)`) to `schema.sqlite.ts` + `schema.pg.ts` + server re-export `db/schema.ts`. Runtime re-export left untouched on purpose (claim-based, never reads grants — design D6).
- [x] 1.2 Added `project_member_config` (localPath/joined_at, PK `(project_id, user_id)`) in both schema files + server re-export. New table per the resolved design decision.
- [x] 1.3 Added nullable `projects.organization_id` (null = personal) in both schema files. `team_projects` retirement + backfill deferred to 6.1.
- [x] 1.4 Migrations `067_projects_organization_id` (addColumn), `068_resource_grants` (create table + 2 indexes), `069_project_member_config` (create table) in `server/src/db/migrate.ts`. Create-only, no backfill. Verified: suite logs "Applied 69 migration(s)".
- [x] 1.5 Tests in `server/__tests__/db/schema.test.ts`: grant round-trip, composite-PK idempotent upsert, config table + `organization_id` column. `seedResourceGrant` helper + `seedProject` `organizationId` override added. 12/12 green; 77/77 across project repo/manager/collaborators/routes still green; no new typecheck errors.

## 2. Role model — one lattice ✅ DONE

- [x] 2.1 Canonical `Role` + `ROLE_RANK` + `rank()` + `roleAtLeast()` + `maxRole()` + `isRole()` in a new pure module `packages/shared/src/auth/roles.ts` (exported as `@funny/shared/auth/roles`). Kept type-only `types.ts`; `TeamRole` gets a pointer comment (call-site migration deferred to Phases 4/7, not a breaking change here). Also added the `Capability`→min-rank map + `roleCan()` (design D5).
- [x] 2.2 `roleLabel(resourceType, role)` — org/project use "Member" for contributor; thread renames contributor/admin→"Steer", viewer→"View".
- [x] 2.3 Org `viewer` made real: registered `viewer = ac.newRole({…empty…})` and added to the org plugin `roles` map in `server/src/lib/auth.ts`. `TeamRole`'s 'viewer' is no longer a phantom.
- [x] 2.4 Tests `packages/shared/src/__tests__/auth/roles.test.ts` (13): rank totality, `roleAtLeast`/`maxRole`, capability mapping, `view→viewer`/`steer→contributor` aliases + round-trip, `member↔contributor` org alias, labels. 13/13 green; typecheck ✓ no new errors; `team-settings`/`invite-links` route tests still pass (the 2 `auth-middleware.test.ts` failures are pre-existing — reproduced with my changes stashed).

## 3. Grant repository + authorizer ✅ DONE

- [x] 3.1 `packages/shared/src/repositories/grant-repository.ts` (DI'd, mirrors `thread-share-repository`): `getGrant`, `getGrantRole`, `upsertGrant` (idempotent `onConflictDoUpdate` + role validation), `deleteGrant`, `listGrantsForResource`, `listResourcesForSubject`. Exported from `repositories/index.ts`.
- [x] 3.2 `packages/shared/src/auth/authorizer.ts` (`createAuthorizer`, pure/DI'd, exported `@funny/shared/auth/authorizer`): `effectiveRole` walks thread→project→org with the creator-owner shortcut and `max`-by-rank combine; `authorize(user, type, id, capability)` gates by `roleCan` (D5).
- [x] 3.3 Org read-adapter is `orgRoleToRole` (Phase 2) + an injected `getOrgRole` seam on the authorizer — the server wires it to Better Auth `member` in Phase 4. Write-side shadow-sync deferred to Phase 6/8 (backfill/cutover) to avoid writing the still-unused table now.
- [x] 3.4 **Security gate** `canCrossToOwnerRunner` added: runner-bound thread actions require ownership OR an EXPLICIT thread steer grant — inheritance is deliberately NOT consulted (design D6). Phase 5 wires the proxy/steer path through it.
- [x] 3.5 Tests: `grant-repository.test.ts` (real in-memory SQLite, 5) + `authorizer.test.ts` (inheritance matrix + runner-crossing gate, 13). Shared test-db helper gained `resource_grants` + `projects.organization_id`. 30/30 across the three RBAC files; full shared suite 340/340; typecheck ✓ no new errors.

## 4. Populate the unified table — dual-WRITE (expand phase) ✅ DONE

> Scope corrected during implementation. Enabling INHERITANCE and switching READS
> to `resource_grants` both change behavior and require grant-cleanup-on-delete
> first (the table is polymorphic — `resource_id` can't FK to threads/projects, so
> it does NOT cascade). Those move to Phases 5–8. Phase 4 is the safe expand half:
> start writing the new table, keep reading the legacy ones, behavior-identical.

- [x] 4.1 `thread-share-repository.ts` now dual-WRITES: `createShare` writes `thread_shares` AND upserts a `resource_grants` thread row (`view→viewer`, `steer→contributor`); `deleteShare` deletes both. Reads (`hasShare`/`getShareLevel`/lists) stay on `thread_shares` — read-switch deferred to Phase 8 (see cascade note in the module header).
- [x] 4.2 `project-manager.ts` `addMember`/`removeMember` dual-write a `resource_grants` project row via `projectRoleToCanonical` (`member→contributor`, `admin→admin`). `isProjectMember`/`listMembers` stay on `project_members`.
- [x] 4.3 Test isolation: added `resource_grants`/`thread_shares`/`project_member_config` to the shared `test-app.ts` `cleanup()` table list (the polymorphic table doesn't cascade, so it leaked across tests). Root-caused a 3-test failure to exactly this.
- [x] 4.4 Tests: new dual-write assertions in `thread-share-repository.test.ts` (grant role written/removed) + `project-manager.test.ts` (canonical role + upsert + remove). Full `packages/server` suite **757/757**, full shared suite **341/341**, typecheck ✓ no new errors. `getOrgProjectIds` removal + `routes/projects.ts` listing rewrite move to Phase 7 (they're read-path/inheritance, gated on backfill).

## 4b. Wire reads through the authorizer (NO inheritance — corrected)

- [x] 4b.1 **Thread access via the unified authorizer.** New `lib/server-authorizer.ts` binds `createAuthorizer` to the grant repo + Better Auth `member` (org) + thread/project owner loaders. `middleware/thread-access.ts` factory takes injected `authorizeView`/`authorizeSteer`; `routes/threads.ts` wires **view → `authorize('thread', id, 'view')`** and **steer → `canSteerThread`** (owner OR explicit thread steer). Hot-path inline reads + WS `canUserViewThread` go through the authorizer. `requireThreadOwner` stays creator-only.

- [x] 4b.1-CORRECTION **Removed inheritance — threads are PRIVATE.** Per the product owner: org/project membership must NOT auto-expose other users' threads. The authorizer no longer walks any chain — `effectiveRole` = explicit grant on THAT resource OR ownership (design D4 rewritten). `ThreadMeta`/`ProjectMeta` simplified to `{ownerId}`; server loaders + tests updated.
  - Tests: `thread-privacy.test.ts` (renamed) now asserts a project admin / org admin get **404** on a thread with no explicit share; an explicit share is the only non-owner way in. `authorizer.test.ts` + backfill golden rewritten for no-inheritance. Full server **767/767**, shared **340/340**, typecheck ✓.

- [x] 4b.1-COMMENTER **Three thread share levels: viewer < commenter < editor.** Lattice gains `commenter` (rank 1; viewer 0, contributor/editor 2, admin 3, owner 4) + a `comment` capability. `threadLevelToRole`/`ShareLevel` now 3-way (`view|comment|steer`). `POST /:id/comments` requires the `comment` capability (a viewer reads but cannot post → 403); the share API accepts `level: 'comment'`. Labels: thread → Viewer / Commenter / Editor.
  - Tests: `roles.test.ts` updated (5-role lattice, comment capability, 3 levels); `thread-shares.test.ts` gains "commenter can comment" + "viewer cannot comment (403)".
- [ ] 4b.2 Switch `thread-share-repository`/`project-manager` internal reads to `resource_grants` (cosmetic now that the authorizer is the gate; fold into Phase 8 read-switch).
- [ ] 4b.3 Replace `routes/projects.ts` subtract-org-add-members listing with `authorize` + `listResourcesForSubject`; delete `getOrgProjectIds`. (org members would then see org projects via inheritance — behavior change, own tests.)
- [ ] 4b.4 `localPath` reads/writes point at `project_member_config` (needs a localPath backfill first — Phase 7/8).

## 5. Steer boundary — extend signed claim, not the allow-list

- [ ] 5.1 Generalize the forwarded-identity claim `shareLevel` → `effectiveRole: Role` in `shared/src/auth/forwarded-identity.ts` (back-compat: infer from absent field).
- [ ] 5.2 Update `middleware/proxy.ts` to sign the resolved effective role; allow-list and `share.steer_delegation` audit unchanged.
- [ ] 5.3 Runtime `utils/route-helpers.ts` re-authorizes against the signed role's rank; runner crossing stays strictly the allow-listed steer path (inheritance grants UI/read only, never a new crossing).
- [ ] 5.4 Security test (extend `proxy-steer-delegation.test.ts`): a project-admin who is NOT a steer sharee gets 404/502 on runner-bound thread routes (inheritance must not cross isolation); a steer sharee still works.

## 6. Backfill migration + grant cleanup-on-delete ✅ DONE

- [x] 6.1 Migration `070_backfill_resource_grants` (+ exported `backfillResourceGrants`): `project_members`→project grants, `thread_shares`→thread grants (canonical role mapping), and `team_projects`→`projects.organization_id` (denormalize org→project edge, design D2). Idempotent via `WHERE NOT EXISTS` (SQLite rejects `INSERT…SELECT…ON CONFLICT`), so it's safe to re-run and safe alongside the Phase 4 dual-write (pre-existing grants kept). Org membership stays canonical in Better Auth `member` (D1) — not copied.
- [x] 6.2 **Grant cleanup-on-delete** (the polymorphic table doesn't cascade): `grant-repository.deleteGrantsForResource`; wired into `thread-repository.deleteThread` (thread grants) and server `project-repository.deleteProject` (project grant + all its threads' grants, purged before the cascade). This is what unblocks 4b's read-switch.
- [x] 6.3 Tests: `backfill-grants.test.ts` (server, 5) — role mapping, org denormalization, idempotency-preserves-dual-write, **golden authorizer matrix over real backfilled data** (org admin inherits + `canCrossToOwnerRunner` false), and `deleteProject` purge; `grant-cleanup.test.ts` (shared) — `deleteThread` purge. Full server suite **762/762**, full shared **342/342**, typecheck ✓ no new errors. "Applied 70 migration(s)" confirmed.
- [ ] 6.4 Divergence telemetry (legacy result ≠ grants result) moves to 4b/Phase 8 — it only makes sense once reads dual-read, which is still deferred.

## 7. Client — one role model + the "assign users to projects" settings UX (D8)

- [x] 7.1a **Thread share UI — 3 levels (viewer / commenter / editor).** `lib/api/threads.ts` `ShareLevel` → `'view' | 'comment' | 'steer'`; `ShareThreadButton` picker now has three segments (Viewer / Commenter / Editor) with per-level hints and a `Can view/comment/edit` access label. `shared/types/thread.ts` `viewerShareLevel` gains `'comment'`. New `canCommentShare` predicate in `thread-variant.ts`; `CommentsPane` hides the composer for a view-only sharee (read-only notice) — mirrors the server `comment` capability gate. Tests: `thread-variant.test.ts` +3 (`canCommentShare`); client build + typecheck green. Remaining 7.1: migrate `TeamMembers`/`OrgSwitcher` and the project role colors onto `roleLabel`.
- [ ] 7.2 `lib/api/projects.ts` + `lib/api/threads.ts` types use unified `Role`.
- [x] 7.3 **Role picker on add** — `ProjectCollaborators` add flow gained a `Viewer | Member | Admin` shadcn Select (`collaborators-role-select`) with a per-role hint, replacing the hardcoded `'member'`; `handleAdd` uses the selected role. `ProjectMemberRole` → `'viewer' | 'member' | 'admin'`.
- [x] 7.4 **Edit existing role** — each non-owner/non-self member row renders an inline role Select (`collaborators-role-${userId}`) that re-roles via the upserting `addProjectMember`; owner/self stay static badges.
- [x] 7.8 (server) `POST /:id/members` validates `role` against `ASSIGNABLE_PROJECT_ROLES` ({viewer, member, admin}) → 400 `invalid-project-role` otherwise. Tests: +3 in `project-collaborators.test.ts` (valid role, invalid→400 no write, upsert re-role). Server **770/770**, client build ✓, typecheck ✓.
- [x] ~~7.5 Inherited vs explicit split~~ — **dropped**: there is no inheritance (privacy correction), so there are no inherited members to display. The collaborator list shows explicit grants only.
- [ ] 7.6 **Org ownership control** — `TeamProjects` "Share with team" writes `projects.organization_id` (set/clear) instead of a `team_projects` row; copy updated to "owning organization". Keep `data-testid`s.
- [ ] 7.7 `localPath`/"needs setup" badge reads from `project_member_config`; renders identically.
- [ ] 7.8 Server: rewrite `isProjectAdmin` + `GET/POST/DELETE /:id/members` in `routes/projects.ts` over `authorize(.., 'project', id, cap)`; `POST /:id/members` validates `role` against the lattice (reject unknown roles with 400). Tests in `project-collaborators.test.ts` extended for the role picker + inherited rows + role validation.
- [ ] 7.9 `data-testid` + label parity check; no NEW end-user capability beyond surfacing role assignment that the data model already allowed.

## 8. Cutover + retire

- [ ] 8.1 After a clean divergence-telemetry release: switch writes fully to `resource_grants` (+ Better Auth member adapter).
- [ ] 8.2 Drop legacy reads, then drop `thread_shares`, `team_projects`, and `project_members.role` (keep config table). Final migration.
- [ ] 8.3 Update `CLAUDE.md` (scratch + steer + runner-isolation sections) to describe the unified model; supersede the access notes in `thread-sharing` / `thread-sharing-steer`.
- [ ] 8.4 `bun run build` + full type-check + the security test matrices green.
