/**
 * Canonical RBAC role lattice (unified-rbac-grants, Phase 2).
 *
 * ONE role vocabulary for every resource (org / project / thread), replacing the
 * four overlapping enums that exist today (`TeamRole`, project `admin|member`,
 * thread `view|steer`, plus the implicit creator-owner). Roles are totally
 * ordered by rank, so authorization is a rank comparison and inheritance
 * (thread → project → org) is `max` by rank.
 *
 * This module is pure (no DB, no Better Auth) so it can be imported from server,
 * runtime, and client alike. The resolver, the grant repository, and the UI all
 * speak `Role`; the legacy aliases below convert at the edges during migration.
 */

export type Role = 'owner' | 'admin' | 'contributor' | 'commenter' | 'viewer';

export type ResourceType = 'org' | 'project' | 'thread';

/**
 * Total order over roles. Higher = more access. `commenter` sits between
 * `viewer` (read-only) and `contributor` (the thread "editor" — read + comment +
 * follow-ups/steer): a commenter can read AND comment but cannot steer.
 */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  commenter: 1,
  contributor: 2,
  admin: 3,
  owner: 4,
};

/** Every role, ascending by rank — handy for pickers / iteration. */
export const ROLES_ASCENDING: readonly Role[] = [
  'viewer',
  'commenter',
  'contributor',
  'admin',
  'owner',
];

export function rank(role: Role): number {
  return ROLE_RANK[role];
}

/** True when `role` is at least as privileged as `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** The more-privileged of two roles — the `max` used by inheritance (design D4). */
export function maxRole(a: Role, b: Role): Role {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/** Narrowing guard for untrusted input (route bodies). */
export function isRole(value: unknown): value is Role {
  return (
    value === 'owner' ||
    value === 'admin' ||
    value === 'contributor' ||
    value === 'commenter' ||
    value === 'viewer'
  );
}

// ── Capabilities ────────────────────────────────────────────────
// A capability is the thing a route guards; each requires a minimum rank
// (design D5). Authorization = effectiveRole.rank >= capability.minRank.

export type Capability = 'view' | 'comment' | 'steer' | 'manage' | 'delete';

export const CAPABILITY_MIN_RANK: Record<Capability, number> = {
  view: ROLE_RANK.viewer, // read, read git (ro)
  comment: ROLE_RANK.commenter, // post a comment on a thread
  steer: ROLE_RANK.contributor, // follow-up / edit
  manage: ROLE_RANK.admin, // manage members, settings, git write
  delete: ROLE_RANK.owner, // delete, transfer
};

export function roleCan(role: Role, capability: Capability): boolean {
  return ROLE_RANK[role] >= CAPABILITY_MIN_RANK[capability];
}

// ── Thread share level ↔ role ───────────────────────────────────
// A thread is shared at one of three explicit levels, mapped onto the lattice:
//   'view'    → viewer      (read only)
//   'comment' → commenter   (read + comment)
//   'steer'   → contributor (read + comment + follow-ups / edit)

export type ThreadShareLevel = 'view' | 'comment' | 'steer';

export function threadLevelToRole(level: ThreadShareLevel): Role {
  if (level === 'steer') return 'contributor';
  if (level === 'comment') return 'commenter';
  return 'viewer';
}

export function roleToThreadLevel(role: Role): ThreadShareLevel {
  if (roleAtLeast(role, 'contributor')) return 'steer'; // editor+ (incl. admin/owner)
  if (roleAtLeast(role, 'commenter')) return 'comment';
  return 'view';
}

// ── Legacy org role ↔ canonical (Better Auth stores owner/admin/member/viewer) ─
// Better Auth's `member.role` uses 'member' where the lattice says 'contributor'.

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export function orgRoleToRole(orgRole: OrgRole): Role {
  return orgRole === 'member' ? 'contributor' : orgRole;
}

export function roleToOrgRole(role: Role): OrgRole {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'admin':
      return 'admin';
    case 'viewer':
      return 'viewer';
    default:
      return 'member'; // contributor + commenter have no distinct org role
  }
}

// ── Per-resource UI labels ──────────────────────────────────────
// The stored/compared value is always the canonical Role; labels differ only at
// the UI edge. Thread scope has no distinct "admin" — an inherited admin/owner
// reads as the steer capability, so it labels as "Steer".

const RESOURCE_ROLE_LABELS: Record<ResourceType, Record<Role, string>> = {
  org: {
    owner: 'Owner',
    admin: 'Admin',
    contributor: 'Member',
    commenter: 'Commenter',
    viewer: 'Viewer',
  },
  project: {
    owner: 'Owner',
    admin: 'Admin',
    contributor: 'Member',
    commenter: 'Commenter',
    viewer: 'Viewer',
  },
  // Thread scope: the three share levels + owner. `admin` shouldn't occur on a
  // thread (no inheritance) but maps to Editor for safety.
  thread: {
    owner: 'Owner',
    admin: 'Editor',
    contributor: 'Editor',
    commenter: 'Commenter',
    viewer: 'Viewer',
  },
};

export function roleLabel(resourceType: ResourceType, role: Role): string {
  return RESOURCE_ROLE_LABELS[resourceType][role];
}
