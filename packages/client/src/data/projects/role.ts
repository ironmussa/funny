import { roleCan, type Capability, type Role } from '@funny/shared/auth/roles';

import { projectsApi } from '@/lib/api/projects';

import { unwrapResult } from '../query-client';

/**
 * The caller's effective role on one project, as the server resolves it. Only
 * used to hide controls the server would refuse; the server still decides.
 * Roles change rarely, and a reconnect's resync refetches it.
 */
export function projectRoleQuery(projectId: string) {
  return {
    queryKey: ['projects', 'my-role', projectId] as const,
    queryFn: async (): Promise<Role> =>
      (await unwrapResult(projectsApi.getMyProjectRole(projectId))).role,
    staleTime: 60_000,
  };
}

/** Whether `role` holds `capability`; `undefined` (still loading) is treated as allowed. */
export function roleAllows(role: Role | undefined, capability: Capability): boolean {
  return role === undefined || roleCan(role, capability);
}
