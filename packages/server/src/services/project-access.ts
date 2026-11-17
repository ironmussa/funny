/**
 * @domain subdomain: Projects
 * @domain subdomain-type: supporting
 * @domain type: application-service
 * @domain layer: application
 *
 * Shared project-access gate for per-(project, user) settings services
 * (project-sandbox-settings, issue-factory). It decides through the same
 * role resolver and capability lattice as the REST `requireProjectAccess`
 * guard and the tRPC `projectProcedure` (`decideProjectAccess`), so a viewer
 * row in `project_members` (written by `setMemberLocalPath`) or an org share
 * grants only what the viewer role allows: no role → not found, a role
 * without the capability → forbidden.
 */
import type { Capability } from '@funny/shared/auth/roles';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';

import { projectRole } from '../lib/server-authorizer.js';
import { decideProjectAccess } from '../middleware/project-access.js';

export interface ProjectAccessErrors<E> {
  storage: (error: unknown) => E;
  notFound: () => E;
  forbidden: () => E;
}

/** Resolves ok when `userId` holds `capability` on `projectId`. */
export function requireProjectAccess<E>(
  userId: string,
  projectId: string,
  capability: Capability,
  errors: ProjectAccessErrors<E>,
): ResultAsync<void, E> {
  return ResultAsync.fromPromise(
    decideProjectAccess(projectRole, capability, projectId, userId),
    errors.storage,
  ).andThen((refused) => {
    if (!refused) return okAsync<void, E>(undefined);
    return errAsync<void, E>(refused.status === 404 ? errors.notFound() : errors.forbidden());
  });
}
