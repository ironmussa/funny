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

/**
 * Whether `userId` may READ `thread`. Today: owner only. `thread-sharing`
 * widens this to `owner OR hasShare(thread.id, userId)` — this is the single
 * seam that change touches.
 */
export function canViewThread(thread: Pick<Thread, 'userId'>, userId: string): boolean {
  return isThreadOwner(thread, userId);
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
 * Build the two access middlewares around a thread loader. `routes/threads.ts`
 * wires this with its `threadRepo.getThread`; tests pass a fake loader.
 */
export function createThreadAccessMiddleware(loadThread: ThreadLoader): ThreadAccessMiddleware {
  function make(
    authorize: (thread: Thread, userId: string) => boolean,
  ): MiddlewareHandler<ServerEnv> {
    return async (c, next) => {
      const id = c.req.param('id');
      const userId = c.get('userId') as string;
      const thread = id ? await loadThread(id) : null;
      if (!thread || !authorize(thread, userId)) {
        return c.json({ error: 'Thread not found' }, 404);
      }
      c.set('thread', thread);
      return next();
    };
  }

  return {
    requireThreadView: make(canViewThread),
    requireThreadOwner: make(isThreadOwner),
  };
}
