/**
 * Unified authorizer (unified-rbac-grants).
 *
 * Resolves a subject's role on a resource and answers capability checks by rank
 * (design D5). Pure logic over injected loaders — no DB, no Better Auth — so it
 * unit-tests with fakes (mirrors `createThreadAccessMiddleware`).
 *
 * THREADS ARE EXPLICIT — a role on a thread comes ONLY from being its creator
 * (owner) or holding an explicit grant on THAT thread. Being a member of the
 * owning org, or of the owning project, grants NOTHING on a thread by itself —
 * threads are private and must be shared one by one (viewer / commenter /
 * editor). This is a deliberate privacy choice: org membership must never
 * auto-expose other users' threads.
 *
 * PROJECTS ARE SHARED WORKSPACES — a role on a project comes from being its
 * creator (owner), an explicit grant (collaborators are dual-written as project
 * grants: admin → admin, member → contributor), OR membership in an org the
 * project is shared with, which yields `viewer` only. Org members can read the
 * project and its sub-resources; changing them takes `manage` (admin+).
 *
 * `canCrossToOwnerRunner` is the even-narrower gate for runner-bound actions:
 * owner OR an explicit thread grant that can steer (editor+). Phase 5 wires the
 * proxy/steer path through it.
 */

import type { Capability, ResourceType, Role } from './roles.js';
import { maxRole, roleAtLeast, roleCan } from './roles.js';

/** Minimal thread facts: who owns it. */
export interface ThreadMeta {
  ownerId: string;
}

/** Minimal project facts: who owns it. */
export interface ProjectMeta {
  ownerId: string;
}

export interface AuthorizerDeps {
  /** Explicit grant role on an exact resource (from `resource_grants`). */
  getGrantRole: (
    subjectId: string,
    resourceType: ResourceType,
    resourceId: string,
  ) => Promise<Role | null>;
  /**
   * The subject's org role (canonical), or null if not a member. Backed by
   * Better Auth `member` (design D1), NOT `resource_grants`. Used ONLY to
   * authorize org-scoped resources — it does NOT cascade to projects/threads.
   */
  getOrgRole: (subjectId: string, orgId: string) => Promise<Role | null>;
  /** Load a thread's owner, or null if it doesn't exist. */
  loadThreadMeta: (threadId: string) => Promise<ThreadMeta | null>;
  /** Load a project's owner, or null if it doesn't exist. */
  loadProjectMeta: (projectId: string) => Promise<ProjectMeta | null>;
  /** Orgs the project is shared with. Members of any of them get `viewer`. */
  listProjectOrgIds?: (projectId: string) => Promise<string[]>;
}

/** Highest-rank non-null role among the candidates, or null if all null. */
function combine(...roles: Array<Role | null>): Role | null {
  return roles.reduce<Role | null>(
    (acc, r) => (r === null ? acc : acc === null ? r : maxRole(acc, r)),
    null,
  );
}

export function createAuthorizer(deps: AuthorizerDeps) {
  const { getGrantRole, getOrgRole, loadThreadMeta, loadProjectMeta, listProjectOrgIds } = deps;

  /** `viewer` when the subject belongs to any org the project is shared with. */
  async function projectOrgRole(userId: string, projectId: string): Promise<Role | null> {
    if (!listProjectOrgIds) return null;
    for (const orgId of await listProjectOrgIds(projectId)) {
      if ((await getOrgRole(userId, orgId)) !== null) return 'viewer';
    }
    return null;
  }

  async function effectiveProjectRole(userId: string, projectId: string): Promise<Role | null> {
    const meta = await loadProjectMeta(projectId);
    if (!meta) return null;
    if (meta.ownerId === userId) return 'owner';
    // Org sharing only ever yields `viewer`, so any explicit grant already covers it.
    const explicit = await getGrantRole(userId, 'project', projectId);
    return explicit ?? projectOrgRole(userId, projectId);
  }

  async function effectiveThreadRole(userId: string, threadId: string): Promise<Role | null> {
    const meta = await loadThreadMeta(threadId);
    if (!meta) return null;
    const explicit = await getGrantRole(userId, 'thread', threadId);
    const ownerShortcut: Role | null = meta.ownerId === userId ? 'owner' : null;
    return combine(explicit, ownerShortcut);
  }

  /** The subject's role on a resource — explicit grant or ownership only. */
  async function effectiveRole(
    userId: string,
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<Role | null> {
    switch (resourceType) {
      case 'org':
        return getOrgRole(userId, resourceId);
      case 'project':
        return effectiveProjectRole(userId, resourceId);
      case 'thread':
        return effectiveThreadRole(userId, resourceId);
    }
  }

  /** True iff the subject's effective role meets the capability's min rank. */
  async function authorize(
    userId: string,
    resourceType: ResourceType,
    resourceId: string,
    capability: Capability,
  ): Promise<boolean> {
    const role = await effectiveRole(userId, resourceType, resourceId);
    return role !== null && roleCan(role, capability);
  }

  /**
   * SECURITY gate for runner-bound actions on a thread (follow-up, git read).
   * Crossing into the OWNER's runner is allowed ONLY for the owner or a holder
   * of an EXPLICIT thread-level steer grant (contributor+). Inheritance is
   * intentionally NOT consulted — an org/project admin who was never explicitly
   * shared the thread cannot steer it. See `thread-sharing-steer` + design D6.
   */
  async function canCrossToOwnerRunner(userId: string, threadId: string): Promise<boolean> {
    const meta = await loadThreadMeta(threadId);
    if (!meta) return false;
    if (meta.ownerId === userId) return true;
    const explicit = await getGrantRole(userId, 'thread', threadId);
    return explicit !== null && roleAtLeast(explicit, 'contributor');
  }

  return { effectiveRole, authorize, canCrossToOwnerRunner };
}

export type Authorizer = ReturnType<typeof createAuthorizer>;
