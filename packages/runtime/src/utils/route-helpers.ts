/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 */

/**
 * Route helper utilities — return Result<T, DomainError> for common lookups.
 *
 * All thread-access helpers accept a userId parameter to enforce ownership
 * checks in multi-user mode. In local mode (userId='__local__'), ownership
 * is not enforced since there is only one user.
 *
 * An optional organizationId parameter allows team members to access shared
 * projects via the team_projects join table.
 */

import { notFound, forbidden, type DomainError } from '@funny/shared/errors';
import { ok, err, type Result } from 'neverthrow';

import * as pm from '../services/project-manager.js';
import * as tm from '../services/thread-manager.js';

/** Check that a thread belongs to the requesting user (multi-user mode) */
function checkOwnership(thread: { userId: string }, userId: string): Result<void, DomainError> {
  // Local mode: single user, no ownership check needed
  if (userId === '__local__') return ok(undefined);
  if (thread.userId !== userId) return err(forbidden('Access denied'));
  return ok(undefined);
}

/** Get a thread by ID or return Err(NOT_FOUND). Verifies ownership in multi-user mode. */
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
        const isTeam = await pm.isProjectInOrg(thread.projectId, organizationId);
        if (isTeam) return ok(thread);
      }
      return err(ownerCheck.error);
    }
  }
  return ok(thread);
}

/** Get a thread with messages by ID or return Err(NOT_FOUND). Verifies ownership in multi-user mode. */
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
        const isTeam = await pm.isProjectInOrg(result.projectId, organizationId);
        if (isTeam) return ok(result);
      }
      return err(ownerCheck.error);
    }
  }
  return ok(result);
}

/** Get a project by ID or return Err(NOT_FOUND). Verifies ownership in multi-user mode. */
export async function requireProject(
  id: string,
  userId?: string,
  organizationId?: string,
): Promise<Result<NonNullable<Awaited<ReturnType<typeof pm.getProject>>>, DomainError>> {
  const project = await pm.getProject(id);
  if (!project) return err(notFound('Project not found'));
  if (userId) {
    const ownerCheck = checkOwnership(project, userId);
    if (ownerCheck.isErr()) {
      if (organizationId) {
        const isTeam = await pm.isProjectInOrg(project.id, organizationId);
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
 * Verifies ownership in multi-user mode.
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
  const project = await pm.getProject(thread.projectId);
  if (!project) return err(notFound('Project not found'));
  return ok(project.path);
}
