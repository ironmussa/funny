/**
 * The authorization decisions of `projectProcedure` and `adminProcedure`,
 * through the same code as the REST `requireProjectAccess` and `requireAdmin`.
 */

import { failure, type AuthzPort } from '@funny/api';

import { audit } from '../../lib/audit.js';
import { projectRole } from '../../lib/server-authorizer.js';
import { decideProjectAccess } from '../../middleware/project-access.js';

export const authzPort: AuthzPort = {
  async projectAccess(capability, projectId, userId) {
    const refused = await decideProjectAccess(projectRole, capability, projectId, userId);
    return refused && failure(refused.status, refused.message);
  },

  adminRefused(userId, path, role) {
    audit({
      action: 'authz.cross_tenant_refused',
      actorId: userId,
      detail: 'requireAdmin gate — caller is not an admin',
      meta: { path: `/api/trpc/${path}`, method: 'TRPC', role },
    });
  },
};
