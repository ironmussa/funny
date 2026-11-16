/**
 * @domain subdomain: Projects
 * @domain subdomain-type: supporting
 * @domain type: application-service
 * @domain layer: application
 *
 * Shared project-access gate for per-(project, user) settings services
 * (project-runtime-settings, issue-factory): a caller may read or write their
 * own row on a project they can access — its owner, or a member in
 * `project_members`. Anything else is reported as not found, the same trust
 * boundary both services need.
 */
import { and, eq } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../db/index.js';
import { projectMembers, projects } from '../db/schema.js';

/** Resolves ok when `userId` owns or is a member of `projectId`, else `notFound`. */
export function requireProjectAccess<E>(
  userId: string,
  projectId: string,
  storage: (error: unknown) => E,
  notFound: () => E,
): ResultAsync<void, E> {
  return ResultAsync.fromPromise(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId))),
    storage,
  ).andThen(([owned]) => {
    if (owned) return okAsync<void, E>(undefined);
    return ResultAsync.fromPromise(
      db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))),
      storage,
    ).andThen(([member]) => (member ? okAsync<void, E>(undefined) : errAsync<void, E>(notFound())));
  });
}
