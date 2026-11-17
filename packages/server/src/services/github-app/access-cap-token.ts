/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: application
 *
 * The personal token whose GitHub access caps a repository-scoped App token
 * minted on someone's behalf (a sandbox thread, an issue factory). It must be
 * THAT user's access: the project's GitHub token is the project owner's
 * credential, so it caps only the owner's own threads. Anyone else is capped by
 * their own saved PAT, or gets no token at all — never the owner's access.
 */
import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { projects } from '../../db/schema.js';
import { getProviderKey } from '../profile-service.js';
import { serverSideProjectGithubToken } from '../runner-scope.js';

export interface AccessCapTokenDeps {
  projectOwner(projectId: string): Promise<string | null>;
  projectToken(projectId: string): Promise<string | null>;
  userToken(userId: string): Promise<string | null>;
}

export function createAccessCapToken(deps: AccessCapTokenDeps) {
  return async (userId: string, projectId: string | null): Promise<string | null> => {
    if (projectId && (await deps.projectOwner(projectId)) === userId) {
      const projectToken = await deps.projectToken(projectId);
      if (projectToken) return projectToken;
    }
    return deps.userToken(userId);
  };
}

/** Production: the project row's owner, its encrypted token, the user's saved PAT. */
export const accessCapToken = createAccessCapToken({
  async projectOwner(projectId) {
    const [row] = await db
      .select({ ownerId: projects.userId })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.ownerId ?? null;
  },
  projectToken: serverSideProjectGithubToken,
  userToken: (userId) => getProviderKey(userId, 'github'),
});
