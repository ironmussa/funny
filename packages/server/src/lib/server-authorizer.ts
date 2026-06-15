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
import { orgRoleToRole, type OrgRole } from '@funny/shared/auth/roles';
import { createGrantRepository } from '@funny/shared/repositories';
import { and, eq } from 'drizzle-orm';

import { db, dbAll, dbRun, schema } from '../db/index.js';

const grants = createGrantRepository({ db, schema, dbAll, dbRun });

export const authorizer = createAuthorizer({
  getGrantRole: (subjectId, resourceType, resourceId) =>
    grants.getGrantRole(subjectId, resourceType, resourceId),

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
});
