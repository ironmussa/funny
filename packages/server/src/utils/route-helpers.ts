/**
 * Route helper utilities — return Result<T, DomainError> for common lookups.
 */

import { ok, err, type Result } from 'neverthrow';
import * as tm from '../services/thread-manager.js';
import * as pm from '../services/project-manager.js';
import { notFound, type DomainError } from '@a-parallel/shared/errors';

/** Get a thread by ID or return Err(NOT_FOUND) */
export function requireThread(id: string): Result<ReturnType<typeof tm.getThread> & {}, DomainError> {
  const thread = tm.getThread(id);
  if (!thread) return err(notFound('Thread not found'));
  return ok(thread);
}

/** Get a thread with messages by ID or return Err(NOT_FOUND) */
export function requireThreadWithMessages(id: string): Result<NonNullable<ReturnType<typeof tm.getThreadWithMessages>>, DomainError> {
  const result = tm.getThreadWithMessages(id);
  if (!result) return err(notFound('Thread not found'));
  return ok(result);
}

/** Get a project by ID or return Err(NOT_FOUND) */
export function requireProject(id: string): Result<NonNullable<ReturnType<typeof pm.getProject>>, DomainError> {
  const project = pm.getProject(id);
  if (!project) return err(notFound('Project not found'));
  return ok(project);
}

/**
 * Resolve the working directory for a thread or return Err(NOT_FOUND).
 * Returns worktreePath if set, otherwise the project path.
 */
export function requireThreadCwd(threadId: string): Result<string, DomainError> {
  return requireThread(threadId).andThen((thread) => {
    if (thread.worktreePath) return ok(thread.worktreePath);
    const project = pm.getProject(thread.projectId);
    if (!project) return err(notFound('Project not found'));
    return ok(project.path);
  });
}
