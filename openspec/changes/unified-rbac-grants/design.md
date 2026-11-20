## Context

funny's authorization is **five systems wearing one word**. Human access control
is split across Better Auth's org plugin (`organization`/`member`/`invitation`,
checked via `requirePermission('member','update')` in
`packages/server/src/routes/team-settings.ts`) and two hand-rolled repositories
(`project_members` via `services/project-manager.ts`, `thread_shares` via
`shared/src/repositories/thread-share-repository.ts`), with a fourth table
`team_projects` linking projects to orgs. Each has its own role enum and is
checked at its own call sites. There is no inheritance: authorization on a thread
(`middleware/thread-access.ts`) never consults the thread's project or org.

Two hard constraints shape every decision below:

- **The runtime has no database.** It re-authorizes proxied requests from a
  _signed_ claim in the forwarded identity (`shared/src/auth/forwarded-identity.ts`),
  not a DB lookup. Any role the runtime needs must travel as a signed claim.
- **Runner isolation is a security boundary, not a convenience.** Requests are
  resolved to the requester's own runner; the single intentional exception is the
  audited, allow-listed `steer` delegation (`middleware/proxy.ts` +
  `thread-sharing-steer`). This change must not widen that.

## Goals / Non-Goals

**Goals**

- One table and one resolver for all _resource_ authorization (org/project/thread).
- One role lattice with documented inheritance org → project → thread.
- Authorization data separated from collaborator configuration (`localPath`).
- Backward-compatible, backfilled migration — no flag day, no lost grants.
- The `steer` boundary and runner isolation preserved bit-for-bit.

**Non-Goals**

- Replacing Better Auth's org plugin (org switching, `getFullOrganization`,
  invitations API). See D1.
- Touching the agent-tool-gating domain (`permission_rules`, `permission_mode`,
  `toolPermissions`). Separate change `agent-tool-policy`.
- New end-user capabilities (no new share levels, no public links).
- Per-capability granular flags. The lattice stays coarse and human-readable.

## Decisions

### D1 — Keep Better Auth as the org _membership_ store; project the unified model on top

Better Auth's `organization()` plugin owns `organization`/`member`/`invitation`
and powers org switching, the active-org header, the encrypted org API key, and
invitations. Fully collapsing `member` into `resource_grants` would mean
reimplementing all of that ourselves — large, risky, and orthogonal to the
confusion we're fixing.

**Decision:** `resource_grants` is the source of truth for **project and thread**
grants and the single _read_ surface for effective roles. Org membership stays in
Better Auth's `member`; a thin adapter exposes each `member` row as a virtual
grant `(userId, 'org', orgId, role)` so the resolver and the UI see **one role
model**. A DB trigger / repository hook keeps a shadow `org` row in
`resource_grants` in sync for query convenience, but `member` remains canonical
for org.

**Why not full collapse:** the cost (replacing org switching + invitations) buys
nothing the adapter doesn't. **Trade-off:** one write path for org (Better Auth)
differs from project/thread (our repo); documented in the repository module so it
isn't re-discovered as a bug. A full collapse stays open as a later change once
the adapter has proven the read model.

### D2 — One table: `resource_grants`

```
resource_grants(
  subject_id    TEXT NOT NULL,             -- user id (room for 'team:' subjects later)
  resource_type TEXT NOT NULL,             -- 'org' | 'project' | 'thread'
  resource_id   TEXT NOT NULL,
  role          TEXT NOT NULL,             -- canonical role (D3)
  granted_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (subject_id, resource_type, resource_id)
)
```

The composite PK makes a re-grant idempotent (same property `thread_shares`
relied on). `thread_shares.sharedByUserId` → `granted_by`; `thread_shares.level`
→ `role`. `project_members.role` → `role`.

**org→project edge.** Today there is _no_ org column on `projects`; the only link
is the `team_projects(team_id, project_id)` join table (read via `getOrgProjectIds`
/ `addProjectToOrg`). For inheritance (D4) the resolver needs "which org owns this
project". Decision: **denormalize** — add `projects.organization_id` (nullable;
null = personal project) and **retire `team_projects`**, so org→project is a single
indexed column join, not a separate membership/edge table. The backfill (D7)
copies each `team_projects` row's `team_id` into `projects.organization_id`
(a project belongs to at most one org — the current code already treats it that
way). This is the one _added_ column; everything else collapses.

### D3 — One role lattice with ranks, resource-specific labels in the UI only

| Canonical     | Rank | Org label | Project label   | Thread label    |
| ------------- | ---- | --------- | --------------- | --------------- |
| `owner`       | 4    | Owner     | Owner (creator) | Owner (creator) |
| `admin`       | 3    | Admin     | Admin           | —               |
| `contributor` | 2    | Member    | Member          | **Editor**      |
| `commenter`   | 1    | —         | —               | **Commenter**   |
| `viewer`      | 0    | Viewer    | Viewer          | **Viewer**      |

One enum in code (`Role`, with `rank(role)`), localized labels at the edge
(`thread-variant.ts` / a `roleLabel(resourceType, role)` map). At thread scope the
three share levels are `viewer` (read), `commenter` (read + comment), `contributor`
(read + comment + follow-ups = "Editor"). `commenter` is thread-only; org/project
never assign it. The phantom org `viewer` was made real (rank 0).

### D4 — Access is EXPLICIT: no cross-resource inheritance

```
effectiveRole(user, thread)  = max( grant(user, thread),
                                     thread.userId === user ? owner : ⊥ )
effectiveRole(user, project) = max( grant(user, project),
                                     project.userId === user ? owner : ⊥ )
effectiveRole(user, org)     = grant(user, org)   // from Better Auth member (D1)
```

**There is NO inheritance.** A role on a thread/project comes ONLY from being its
creator (owner) or holding an explicit grant on THAT resource. Being a member of
the owning org, or of the owning project, grants **nothing** on a thread — threads
are private and must be shared one by one (viewer / commenter / editor). This is a
deliberate privacy decision (corrected after an earlier inheritance design): org
membership must never auto-expose other users' threads. The creator-is-owner
shortcut is folded in so ownership stops being a parallel concept.

### D5 — One authorizer, replacing scattered checks

`authorize(userId, resourceType, resourceId, capability): Promise<boolean>`
resolves the role (D4) and compares its rank to the capability's required rank.
Capabilities map to ranks once:

| Capability                          | Min rank        |
| ----------------------------------- | --------------- |
| view / read git (ro)                | viewer (0)      |
| comment (post on a thread)          | commenter (1)   |
| steer / follow-up / edit            | contributor (2) |
| manage members, settings, git write | admin (3)       |
| delete, transfer                    | owner (4)       |

`middleware/thread-access.ts` (`requireThreadView/Owner/Steer`) becomes three thin
wrappers over `authorize(..,'thread',id,cap)`. `routes/projects.ts`'s
subtract-org-add-members listing becomes "list resources where
`effectiveRole(user, …) ≥ viewer`". The `getOrgProjectIds` dance is deleted.

### D6 — Runtime stays claim-based; extend the signed claim from level → role

The server already signs `shareLevel` + `onBehalfOfThread` into the forwarded
identity for steer delegation. Generalize `shareLevel: 'view'|'steer'` to
`effectiveRole: Role` (back-compat: runtime maps absent→infer from legacy field).
The runtime's re-authorization (`utils/route-helpers.ts`) compares the **signed**
role to the action's required rank — same allow-list, same audit record
(`share.steer_delegation`), no new crossing. The grants table lives **only on the
server**; the runtime never reads it.

### D7 — Migration: backfill, dual-read, then retire

1. Create `resource_grants` + `project_member_config` (for `localPath`, D-config).
2. Backfill: `project_members`→project grants (+ config), `thread_shares`→thread
   grants, `member`→org grants (shadow), project creators→owner grants.
3. Resolver dual-reads: prefer `resource_grants`, fall back to legacy tables;
   log any divergence (telemetry) for a release.
4. Cut writes over to `resource_grants` (+ the Better Auth `member` adapter).
5. Drop legacy reads, then the `project_members.role`/`thread_shares`/`team_projects`
   tables once divergence telemetry is clean. `project_members` survives only as
   `project_member_config` (renamed) if `localPath` stays there.

Each step ships independently; the system is correct after every step.

### D8 — Settings UX: one "assign users to projects" surface, two access paths

Today the UI has **two unrelated ways to give someone project access**, and a user
has to know which to use:

- **Project Settings → Collaborators** (`ProjectCollaborators.tsx`) — search a user,
  `addProjectMember(projectId, userId, 'member')`. The role is **hardcoded to
  `member`**; there is no picker, so the only way to mint a project admin today is
  not surfaced at all. Owner is implicit (`projects.userId`). `localPath` drives a
  "needs setup" badge.
- **Team Settings → Team Projects** (`TeamProjects.tsx`) — `addTeamProject` writes a
  `team_projects` row, granting the _whole org_ access in bulk.

Under the unified model these become **one concept (a grant) reached two ways**:

1. **Direct project grant** — Collaborators page writes a `resource_grants`
   `(user,'project',id,role)` row. The add flow **gains a role picker**
   (`viewer | contributor | admin`; owner is reserved for the creator/transfer).
   This finally makes "promote a collaborator to admin" a first-class action.
2. **Org ownership** — assigning a project to an org sets `projects.organization_id`
   (D2), and every org member then **inherits** access by rank (D4). The
   `TeamProjects` "Share with team" surface keeps its shape but writes the column
   instead of a `team_projects` row.

The Collaborators list therefore shows **two visually distinct groups**: explicit
grants (removable, role-editable) and **inherited** members (org admins/members,
shown read-only with an "via org" badge) so an admin understands _why_ someone has
access and isn't confused when a user they can't remove appears. `localPath`/"needs
setup" reads from `project_member_config` (D-config) but renders identically.

Server-side: `isProjectAdmin` and the `GET/POST/DELETE /:id/members` gates in
`routes/projects.ts` are rewritten over `authorize(.., 'project', id, cap)` (D5);
`POST /:id/members` validates `role` against the lattice instead of accepting any
string. The role picker, the inherited-vs-explicit split, and the org-ownership
control are the visible deliverables of this whole change — they are what makes
the model legible to the person clicking, not just to the code.

## Risks / Trade-offs

- **Security boundary (highest).** A bug in the resolver could over-grant on
  someone else's runner. Mitigation: the runtime gate is unchanged and independent
  (signed claim + allow-list); the server resolver is covered by the existing
  `thread-access.test.ts` + `proxy-steer-delegation.test.ts` matrices, extended to
  inheritance cases (project admin ⇒ thread steer must NOT cross runner isolation
  unless also steer-delegated — inheritance grants _view/UI_, not runner crossing;
  D6 keeps runner crossing strictly the allow-listed steer path).
- **Better Auth coupling (D1).** Two write paths for roles. Mitigation: single
  documented adapter; org writes never bypass Better Auth.
- **Backfill correctness (D7).** Mitigation: dual-read + divergence telemetry
  before any drop; backfill is idempotent (composite PK).
- **Inheritance surprise.** Org admins suddenly seeing all projects/threads is a
  behavior change. Mitigation: call it out in the proposal; gate the _runner-bound_
  effects behind steer (above) so inheritance is read/UI only until explicitly
  shared.

## Resolved Questions

- **Org `viewer`: made real.** `viewer` (rank 0, read-only org member) is
  registered in the Better Auth access-control config (`lib/auth.ts`) so the
  `TeamRole` type stops lying. Done in Phase 2 (task 2.3).
- **`localPath`: moves to a new `project_member_config` table.** Clean
  separation of authorization (`resource_grants`) from collaborator configuration.
  Costs one extra table + migration; `project_members.role`/`thread_shares`/
  `team_projects` are then fully retired in Phase 8.
- **Invitations: follow-up change.** Unifying `invitation` (email) and
  `invite_links` (token) is independent of the grants model; not in this change.
