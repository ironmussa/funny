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

/** Why a project request is refused, or `null` when the caller holds the capability. */
export type ProjectAccessRefusal = { status: 404 | 403; message: string } | null;

/**
 * The access decision without any HTTP framework. The middleware below and the
 * tRPC `projectProcedure` (`@funny/api`, `trpc/ports/authz.ts`) both decide
 * through this.
 */
export async function decideProjectAccess(
  getRole: ProjectRoleResolver,
  capability: Capability,
  projectId: string | undefined,
  userId: string,
  forbidden = 'Access denied',
): Promise<ProjectAccessRefusal> {
  const role = projectId ? await getRole(userId, projectId) : null;
  if (!role) return { status: 404, message: 'Project not found' };
  if (!roleCan(role, capability)) return { status: 403, message: forbidden };
  return null;
}

export function createProjectAccessMiddleware(getRole: ProjectRoleResolver) {
  return function requireProjectAccess(
    capability: Capability,
    { param = 'id', forbidden = 'Access denied' }: ProjectAccessOptions = {},
  ): MiddlewareHandler<ServerEnv> {
    return async (c, next) => {
      const refused = await decideProjectAccess(
        getRole,
        capability,
        c.req.param(param),
        c.get('userId') as string,
        forbidden,
      );
      if (refused) return c.json({ error: refused.message }, refused.status);
      return next();
    };
  };
}
