/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 */

/**
 * Route helper utilities — return Result<T, DomainError> for common lookups.
 *
 * All thread-access helpers accept a userId parameter to enforce ownership
 * checks. An optional organizationId parameter allows team members to access
 * shared projects via the team_projects join table.
 */

import { notFound, forbidden, type DomainError } from '@funny/shared/errors';
import { ok, err, type Result } from 'neverthrow';

import type { IProjectRepository } from '../services/server-interfaces.js';
import { getServices } from '../services/service-registry.js';
import * as tm from '../services/thread-manager.js';

/** Check that a thread belongs to the requesting user */
function checkOwnership(thread: { userId: string }, userId: string): Result<void, DomainError> {
  if (thread.userId !== userId) return err(forbidden('Access denied'));
  return ok(undefined);
}

/** Get a thread by ID or return Err(NOT_FOUND). Verifies ownership. */
export async function requireThread(
  id: string,
  userId?: string,
  organizationId?: string,
): Promise<Result<Awaited<ReturnType<typeof tm.getThread>> & {}, DomainError>> {
  const thread = await tm.getThread(id);
  if (!thread) return err(notFound('Thread not found'));
  if (userId) {
    const ownerCheck = checkOwnership(thread, userId);
    if (ownerCheck.isErr()) {
      // Ownership failed — check if the thread's project is shared with the org
      if (organizationId) {
        const isTeam = await getServices().projects.isProjectInOrg(
          thread.projectId,
          organizationId,
        );
        if (isTeam) return ok(thread);
      }
      return err(ownerCheck.error);
    }
  }
  return ok(thread);
}

/** Get a thread with messages by ID or return Err(NOT_FOUND). Verifies ownership. */
export async function requireThreadWithMessages(
  id: string,
  userId?: string,
  organizationId?: string,
): Promise<Result<NonNullable<Awaited<ReturnType<typeof tm.getThreadWithMessages>>>, DomainError>> {
  const result = await tm.getThreadWithMessages(id);
  if (!result) return err(notFound('Thread not found'));
  if (userId) {
    const ownerCheck = checkOwnership(result, userId);
    if (ownerCheck.isErr()) {
      if (organizationId) {
        const isTeam = await getServices().projects.isProjectInOrg(
          result.projectId,
          organizationId,
        );
        if (isTeam) return ok(result);
      }
      return err(ownerCheck.error);
    }
  }
  return ok(result);
}

/** Get a project by ID or return Err(NOT_FOUND). Verifies ownership. */
export async function requireProject(
  id: string,
  userId?: string,
  organizationId?: string,
): Promise<
  Result<NonNullable<Awaited<ReturnType<IProjectRepository['getProject']>>>, DomainError>
> {
  const project = await getServices().projects.getProject(id);
  if (!project) return err(notFound('Project not found'));
  if (userId) {
    const ownerCheck = checkOwnership(project, userId);
    if (ownerCheck.isErr()) {
      if (organizationId) {
        const isTeam = await getServices().projects.isProjectInOrg(project.id, organizationId);
        if (isTeam) return ok(project);
      }
      return err(ownerCheck.error);
    }
  }
  return ok(project);
}

/**
 * Resolve the working directory for a thread or return Err(NOT_FOUND).
 * Returns worktreePath if set, otherwise the project path.
 * Verifies ownership.
 */
export async function requireThreadCwd(
  threadId: string,
  userId?: string,
  organizationId?: string,
): Promise<Result<string, DomainError>> {
  const threadResult = await requireThread(threadId, userId, organizationId);
  if (threadResult.isErr()) return err(threadResult.error);
  const thread = threadResult.value;
  if (thread.worktreePath) return ok(thread.worktreePath);
  const project = await getServices().projects.getProject(thread.projectId);
  if (!project) return err(notFound('Project not found'));
  return ok(project.path);
}
