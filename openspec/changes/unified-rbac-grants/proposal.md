## Why

Authorization in funny is spread across **four hand-rolled membership models plus
Better Auth's org plugin**, each with its own role vocabulary. The result is hard
to reason about and the listing code has to reconcile the models by hand.

Concrete sources of confusion today:

1. **Two unrelated things are both called "permission".**
   - _Human access control_ — who may see/do what: `user.role`, org `member`,
     `project_members`, `thread_shares`.
   - _Agent tool gating_ — whether the agent may run a tool: `permission_rules`,
     `user_profiles.toolPermissions`, `permission_mode`.
     They share the word and nothing else. This change touches **only the first**;
     the second is renamed separately (`agent-tool-policy`, out of scope here).

2. **Four role vocabularies that overlap but don't nest.**

   | Scope         | Roles                                             | Source                                  |
   | ------------- | ------------------------------------------------- | --------------------------------------- |
   | User (global) | `admin \| user`                                   | `user.role` (Better Auth `admin()`)     |
   | Org / Team    | `owner \| admin \| member \| viewer` (`TeamRole`) | `member` (Better Auth `organization()`) |
   | Project       | `admin \| member` (+ implicit owner)              | `project_members`                       |
   | Thread        | `view \| steer` (+ implicit owner)                | `thread_shares`                         |

   "admin" means a different thing at each level and there is **no defined
   inheritance** — a project admin has no automatic say over its threads; an org
   admin has no automatic say over its projects. Each is checked independently.

3. **`TeamRole` declares `viewer`, but the access-control config only registers
   `owner/admin/member`** (`packages/server/src/lib/auth.ts:208`). `viewer` is a
   phantom — the type lies about what the system enforces.

4. **Three notions of project membership reconciled by hand.** Listing projects
   (`packages/server/src/routes/projects.ts:61-84`) takes the user's projects,
   **subtracts** org projects (`getOrgProjectIds`), then **adds back**
   `project_members` rows. Three sources of truth for "is this project mine?":
   `project.userId`, `team_projects`, `project_members`.

5. **Two invitation mechanisms** — Better Auth `invitation` (email) and
   `invite_links` (token) — do nearly the same job.

## What Changes

- Introduce **one unified `resource_grants` table** keyed on
  `(subject_id, resource_type, resource_id)` that records a single role per
  subject per resource, for `resource_type ∈ {org, project, thread}`.
- Define **one canonical role lattice** `{owner > admin > contributor > viewer}`
  with an explicit numeric rank, and a documented **inheritance chain
  org → project → thread**. The effective role on a resource is the max of the
  explicit grant and the role inherited from its parent.
- Add a single server-side authorizer
  `authorize(userId, resourceType, resourceId, capability)` that walks the chain,
  **replacing** the per-route owner checks, `canViewThread/canSteerThread`, the
  `project_members` ad-hoc reads, and the `getOrgProjectIds` subtraction dance.
- **Separate authorization from configuration:** the per-member `localPath` (a
  collaborator's working directory, not an access fact) moves out of the role
  model into its own `project_member_config` row.
- Keep the **steer security boundary intact**: the runtime still has no DB and
  re-authorizes via a _signed_ role claim in the forwarded identity; the proxy
  allow-list is unchanged.
- Provide a **backfill + dual-read migration** so the four legacy tables can be
  retired without a flag day.

## Impact

- **Affected specs:** new `unified-rbac` capability; supersedes the access rules
  in `thread-sharing` and `thread-sharing-steer` (those grants become rows in
  `resource_grants` with `resource_type='thread'`).
- **Affected code (server):** `middleware/thread-access.ts`, `middleware/proxy.ts`,
  `routes/{projects,threads,thread-shares,team-projects,team-settings,invite-links}.ts`,
  `services/{project-manager,project-repository}.ts`, `lib/auth.ts`, `db/migrate.ts`.
- **Affected code (shared):** new `repositories/grant-repository.ts`; `thread-share-repository.ts` becomes a thin adapter over it; `types/auth.ts` role types unified.
- **Affected code (client):** `ProjectCollaborators`, `TeamMembers`, `ShareThreadButton`, `OrgSwitcher` read the unified role; one role-label map.
- **Security-sensitive:** the steer delegation path (`thread-sharing-steer`) and
  runner isolation. Every change there is behind the existing allow-list and
  signed-claim machinery; no widening.
- **Out of scope:** renaming the agent-tool-gating domain; replacing Better Auth's
  org switching / invitations API; any new end-user capability.
