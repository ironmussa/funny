/**
 * Server-wired unified authorizer (unified-rbac-grants, Phase 4b).
 *
 * Binds the pure `createAuthorizer` (from `@funny/shared/auth/authorizer`) to the
 * real data sources: the `resource_grants` repository for explicit grants, Better
 * Auth's `member` table for org roles (canonical for org — design D1), and
 * lightweight `threads`/`projects` lookups for the inheritance chain.
 *
 * One shared instance for every access gate (HTTP middleware, hot-path reads, WS
 * presence) so they all resolve identically, with inheritance.
 *
 * @domain subdomain: Authorization
 * @domain type: app-service
 * @domain layer: application
 */

import { createAuthorizer } from '@funny/shared/auth/authorizer';
import {
  orgRoleToRole,
  projectRoleToRole,
  type OrgRole,
  type Role,
} from '@funny/shared/auth/roles';
import { and, eq } from 'drizzle-orm';

import { db, dbAll, schema } from '../db/index.js';
import { repos } from '../db/repos.js';
import { createProjectAccessMiddleware } from '../middleware/project-access.js';

const grants = repos.grants();

/**
 * Collaborator role on a project. `project_members` stays authoritative for
 * project reads until the grants cutover (see `isProjectMember`): rows written
 * before the dual-write — or lazily by `setMemberLocalPath` — have no grant.
 */
async function getProjectMemberRole(userId: string, projectId: string): Promise<Role | null> {
  const rows = await dbAll(
    db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, userId),
        ),
      ),
  );
  const role = (rows[0] as { role?: string } | undefined)?.role;
  return role ? projectRoleToRole(role) : null;
}

export const authorizer = createAuthorizer({
  getGrantRole: (subjectId, resourceType, resourceId) =>
    resourceType === 'project'
      ? getProjectMemberRole(subjectId, resourceId)
      : grants.getGrantRole(subjectId, resourceType, resourceId),

  // Org role is canonical in Better Auth `member` (D1), mapped to the lattice.
  getOrgRole: async (subjectId, orgId) => {
    const rows = await dbAll(
      db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, subjectId))),
    );
    const role = (rows[0] as { role?: string } | undefined)?.role;
    return role ? orgRoleToRole(role as OrgRole) : null;
  },

  loadThreadMeta: async (threadId) => {
    const rows = await dbAll(
      db
        .select({ ownerId: schema.threads.userId })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId)),
    );
    const r = rows[0] as { ownerId: string } | undefined;
    return r ? { ownerId: r.ownerId } : null;
  },

  loadProjectMeta: async (projectId) => {
    const rows = await dbAll(
      db
        .select({ ownerId: schema.projects.userId })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId)),
    );
    const r = rows[0] as { ownerId: string } | undefined;
    return r ? { ownerId: r.ownerId } : null;
  },

  // `team_projects` is the live org↔project share edge (a project can be shared
  // with several orgs; `projects.organization_id` only denormalizes one).
  listProjectOrgIds: async (projectId) => {
    const rows = await dbAll(
      db
        .select({ orgId: schema.teamProjects.teamId })
        .from(schema.teamProjects)
        .where(eq(schema.teamProjects.projectId, projectId)),
    );
    return (rows as { orgId: string }[]).map((r) => r.orgId);
  },
});

/** Route guard for project-scoped routes — see `middleware/project-access.ts`. */
export const requireProjectAccess = createProjectAccessMiddleware((userId, projectId) =>
  authorizer.effectiveRole(userId, 'project', projectId),
);
