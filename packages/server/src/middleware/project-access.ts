/**
 * Centralized per-project authorization — the project counterpart of
 * `thread-access.ts`.
 *
 * Every project-scoped route declares the capability it needs and lets the
 * unified authorizer decide. Who holds which role on a project:
 *
 *  - the creator                                → owner
 *  - a collaborator (`project_members` → grant) → admin or contributor
 *  - a member of an org the project is shared with → viewer
 *
 * A caller with NO role gets the same `404 Project not found` as for a missing
 * project, so a route never reveals that a foreign project exists. A caller who
 * can see the project but lacks the capability gets a 403.
 */

import { roleCan, type Capability, type Role } from '@funny/shared/auth/roles';
import type { MiddlewareHandler } from 'hono';

import type { ServerEnv } from '../lib/types.js';

/** Resolves a user's effective role on a project (`null` = no access / missing). */
export type ProjectRoleResolver = (userId: string, projectId: string) => Promise<Role | null>;

export interface ProjectAccessOptions {
  /** Route param holding the project id. Defaults to `id`. */
  param?: string;
  /** 403 message for a caller who can see the project but lacks the capability. */
  forbidden?: string;
}

export function createProjectAccessMiddleware(getRole: ProjectRoleResolver) {
  return function requireProjectAccess(
    capability: Capability,
    { param = 'id', forbidden = 'Access denied' }: ProjectAccessOptions = {},
  ): MiddlewareHandler<ServerEnv> {
    return async (c, next) => {
      const projectId = c.req.param(param);
      const userId = c.get('userId') as string;
      const role = projectId ? await getRole(userId, projectId) : null;
      if (!role) return c.json({ error: 'Project not found' }, 404);
      if (!roleCan(role, capability)) return c.json({ error: forbidden }, 403);
      return next();
    };
  };
}
