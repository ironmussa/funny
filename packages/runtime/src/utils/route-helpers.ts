/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 */

/**
 * Route helper utilities — return Result<T, DomainError> for common lookups.
 *
 * Thread-access helpers admit only the thread's owner (or a verified steer
 * grant). `requireProject` also admits collaborators and members of an org the
 * project is shared with.
 */

import { mkdirSync } from 'node:fs';

import { badRequest, notFound, forbidden, type DomainError } from '@funny/shared/errors';
import { ok, err, type Result } from 'neverthrow';

import type { IProjectRepository } from '../services/server-interfaces.js';
import { getServices } from '../services/service-registry.js';
import { hasLazyCwd, resolveThreadCwd } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';

/** Check that a thread belongs to the requesting user */
function checkOwnership(thread: { userId: string }, userId: string): Result<void, DomainError> {
  if (thread.userId !== userId) return err(forbidden('Access denied'));
  return ok(undefined);
}

/**
 * A verified steer-share delegation claim (thread-sharing-steer). Lifted from
 * the SIGNED forwarded identity by the runtime auth middleware, so it cannot be
 * forged. When `shareLevel === 'steer'` and `onBehalfOfThread === <thread id>`,
 * the runtime authorizes the sharee for the allow-listed routes on that thread
 * even though they are not the owner. The thread's cwd/agent still resolve off
 * the thread itself (the owner's machine) — never off the sharee.
 */
export interface SteerGrant {
  shareLevel?: string | null;
  onBehalfOfThread?: string | null;
}

/** True when `steer` is a valid `steer` grant for thread `id`. */
export function isSteerGrantFor(id: string, steer?: SteerGrant): boolean {
  return !!steer && steer.shareLevel === 'steer' && steer.onBehalfOfThread === id;
}

/**
 * Read the verified steer-share delegation claim off a Hono context. The runtime
 * auth middleware lifts these from the SIGNED forwarded identity, so they are
 * trustworthy. Pass the result to `requireThread` / `requireThreadCwd` on the
 * allow-listed routes (follow-up + git read-only).
 */
export function steerFromContext(c: {
  get: (k: 'shareLevel' | 'onBehalfOfThread') => string | null | undefined;
}): SteerGrant {
  return {
    shareLevel: c.get('shareLevel') ?? null,
    onBehalfOfThread: c.get('onBehalfOfThread') ?? null,
  };
}

/** Get a thread by ID or return Err(NOT_FOUND). Verifies ownership (or a
 *  verified steer-share delegation for the allow-listed routes). */
export async function requireThread(
  id: string,
  userId?: string,
  steer?: SteerGrant,
): Promise<Result<Awaited<ReturnType<typeof tm.getThread>> & {}, DomainError>> {
  const thread = await tm.getThread(id);
  if (!thread) return err(notFound('Thread not found'));
  if (userId) {
    const ownerCheck = checkOwnership(thread, userId);
    if (ownerCheck.isErr()) {
      // Steer-share delegation: a verified `steer` grant on THIS thread
      // authorizes the sharee (thread-sharing-steer). The server already gated
      // the route + signed the claim; here we just honor it.
      // Nothing else admits a non-owner: threads are private, and org
      // membership never exposes another user's thread (shared/auth/authorizer.ts).
      if (isSteerGrantFor(id, steer)) return ok(thread);
      return err(ownerCheck.error);
    }
  }
  return ok(thread);
}

/** Get a thread with messages by ID or return Err(NOT_FOUND). Verifies ownership. */
export async function requireThreadWithMessages(
  id: string,
  userId?: string,
): Promise<Result<NonNullable<Awaited<ReturnType<typeof tm.getThreadWithMessages>>>, DomainError>> {
  const result = await tm.getThreadWithMessages(id);
  if (!result) return err(notFound('Thread not found'));
  if (userId) {
    const ownerCheck = checkOwnership(result, userId);
    if (ownerCheck.isErr()) return err(ownerCheck.error);
  }
  return ok(result);
}

/**
 * Get a project by ID or return Err(NOT_FOUND). Verifies access and resolves
 * the caller's working directory.
 *
 * Access is granted to: the owner, a **collaborator** (a `project_members` row —
 * the "Collaborators" feature), or a member of an org the project is shared
 * with. For a collaborator the returned project's `path` is overridden with
 * THEIR own configured local directory: each collaborator works through their
 * own runner, so every downstream git op must run against the collaborator's
 * checkout — not the owner's path, which doesn't exist on the collaborator's
 * machine. `resolveProjectPath` performs both the membership authorization and
 * the per-user path lookup (proxied to the server on a runner).
 */
export async function requireProject(
  id: string,
  userId?: string,
  organizationId?: string | null,
): Promise<
  Result<NonNullable<Awaited<ReturnType<IProjectRepository['getProject']>>>, DomainError>
> {
  const project = await getServices().projects.getProject(id);
  if (!project) return err(notFound('Project not found'));
  if (!userId) return ok(project);

  // Owner → authorized; use the project's own path.
  if (project.userId === userId) return ok(project);

  // Collaborator → authorized with their own working directory.
  const resolved = await getServices().projects.resolveProjectPath(id, userId);
  if (resolved.isOk()) return ok({ ...project, path: resolved.value });

  // Org-shared fallback (single-machine team sharing keeps the owner's path).
  if (organizationId) {
    const isTeam = await getServices().projects.isProjectInOrg(project.id, organizationId);
    if (isTeam) return ok(project);
  }
  return err(forbidden('Access denied'));
}

/**
 * Resolve the working directory of an already-authorized thread, creating it
 * when the runner owns it (scratch). Scratch → its scratch directory; a thread
 * with a worktree → the worktree; otherwise the project path as seen by
 * `pathUserId` (a collaborator's own checkout, else the project's path).
 */
export async function ensureThreadCwd(
  thread: NonNullable<Awaited<ReturnType<typeof tm.getThread>>>,
  pathUserId?: string,
): Promise<Result<string, DomainError>> {
  if (thread.worktreePath) return ok(thread.worktreePath);

  let project: { path: string } | null = null;
  if (thread.projectId) {
    const resolved = pathUserId
      ? await getServices().projects.resolveProjectPath(thread.projectId, pathUserId)
      : null;
    if (resolved?.isOk()) {
      project = { path: resolved.value };
    } else {
      const found = await getServices().projects.getProject(thread.projectId);
      if (!found) return err(notFound('Project not found'));
      project = { path: found.path };
    }
  }

  const cwd = resolveThreadCwd(
    thread as unknown as Parameters<typeof resolveThreadCwd>[0],
    project,
  );
  if (cwd.isErr()) return err(badRequest(cwd.error.message));
  if (hasLazyCwd(thread as { isScratch?: boolean })) {
    try {
      mkdirSync(cwd.value, { recursive: true });
    } catch {
      // Callers surface a missing directory as an empty result / clear error.
    }
  }
  return ok(cwd.value);
}

/**
 * Resolve the working directory for a thread the caller may access (see
 * `ensureThreadCwd`). Verifies ownership / steer grant.
 */
export async function requireThreadCwd(
  threadId: string,
  userId?: string,
  steer?: SteerGrant,
): Promise<Result<string, DomainError>> {
  const threadResult = await requireThread(threadId, userId, steer);
  if (threadResult.isErr()) return err(threadResult.error);
  const thread = threadResult.value;
  // For a steer sharee the thread lives on the OWNER's machine — resolve the
  // working directory by the thread owner, never by the sharee (who has no
  // checkout on this runner). Owners/collaborators resolve by their own id.
  const pathUserId = isSteerGrantFor(threadId, steer) ? thread.userId : userId;
  return ensureThreadCwd(thread, pathUserId);
}
