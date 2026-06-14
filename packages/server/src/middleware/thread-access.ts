/**
 * Centralized per-thread authorization.
 *
 * Replaces the ownership check that was copy-pasted across every thread route
 * (`if (!thread || thread.userId !== userId) return 404`). Two access classes:
 *
 *  - `canViewThread`  — may READ the thread. Today this is ownership only; the
 *    `thread-sharing` change widens THIS predicate (and only this one) to also
 *    admit users holding an active share grant.
 *  - `isThreadOwner`  — owner-only. Applied to every route that mutates the
 *    thread, drives its agent, or administers access.
 *
 * Authorization failures and missing threads return the SAME `404 Thread not
 * found` so a route never reveals the existence of a thread the caller may not
 * access (existence-hiding).
 *
 * The middlewares load the thread once and stash it on the request context
 * (`c.set('thread', thread)`) so handlers read `c.get('thread')` instead of
 * re-fetching.
 */

import type { Thread } from '@funny/shared';
import type { MiddlewareHandler } from 'hono';

import type { ServerEnv } from '../lib/types.js';

/** The owner of a thread is the user who created it. */
export function isThreadOwner(thread: Pick<Thread, 'userId'>, userId: string): boolean {
  return thread.userId === userId;
}

/** Looks up whether `userId` holds an active share grant for `threadId`. */
export type HasShare = (threadId: string, userId: string) => Promise<boolean>;

/**
 * Whether `userId` may READ `thread`: the owner, OR a user holding an active
 * share grant (thread-sharing). The owner check short-circuits before any DB
 * hit; the share lookup is injected so this stays DB-agnostic and testable.
 */
export async function canViewThread(
  thread: Pick<Thread, 'id' | 'userId'>,
  userId: string,
  hasShare: HasShare,
): Promise<boolean> {
  return isThreadOwner(thread, userId) || hasShare(thread.id, userId);
}

/** How a thread is resolved by id. Injected so the middleware is testable. */
export type ThreadLoader = (id: string) => Promise<Thread | null | undefined>;

export interface ThreadAccessMiddleware {
  /** Read access (owner today; owner-or-sharee after `thread-sharing`). */
  requireThreadView: MiddlewareHandler<ServerEnv>;
  /** Owner-only access for mutation / lifecycle / git / share-admin routes. */
  requireThreadOwner: MiddlewareHandler<ServerEnv>;
}

/**
 * Build the two access middlewares around a thread loader and a share lookup.
 * `routes/threads.ts` wires these with its `threadRepo.getThread` and
 * `shareRepo.hasShare`; tests pass fakes.
 */
export function createThreadAccessMiddleware(
  loadThread: ThreadLoader,
  hasShare: HasShare,
): ThreadAccessMiddleware {
  function make(
    authorize: (thread: Thread, userId: string) => boolean | Promise<boolean>,
  ): MiddlewareHandler<ServerEnv> {
    return async (c, next) => {
      const id = c.req.param('id');
      const userId = c.get('userId') as string;
      const thread = id ? await loadThread(id) : null;
      if (!thread || !(await authorize(thread, userId))) {
        return c.json({ error: 'Thread not found' }, 404);
      }
      c.set('thread', thread);
      return next();
    };
  }

  return {
    requireThreadView: make((thread, userId) => canViewThread(thread, userId, hasShare)),
    requireThreadOwner: make(isThreadOwner),
  };
}
