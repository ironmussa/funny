/**
 * Server-side per-thread view authorization, usable outside the Hono request
 * cycle (e.g. from Socket.IO presence handlers). Mirrors the HTTP middleware's
 * `canViewThread`: the owner OR a holder of an active share grant may view.
 *
 * Uses a lightweight `userId` lookup rather than the full thread repository so
 * it stays cheap on the WS hot path.
 */

import { eq } from 'drizzle-orm';

import { db, dbAll } from '../db/index.js';
import * as schema from '../db/schema.js';
import { authorizer } from '../lib/server-authorizer.js';

/**
 * Whether `userId` may view `threadId`. Delegates to the unified authorizer so
 * the WS presence path resolves identically to the HTTP gate — owner, explicit
 * share, or inherited (project/org) access all admit a viewer.
 */
export async function canUserViewThread(threadId: string, userId: string): Promise<boolean> {
  return authorizer.authorize(userId, 'thread', threadId, 'view');
}

/** Whether `userId` is the owner of `threadId` (no share grants count). */
export async function isThreadOwnedBy(threadId: string, userId: string): Promise<boolean> {
  const rows = await dbAll(
    db
      .select({ userId: schema.threads.userId })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId)),
  );
  return (rows[0] as { userId: string } | undefined)?.userId === userId;
}

/** Display fields for a presence avatar (name/image), or null if unknown. */
export async function getUserDisplay(
  userId: string,
): Promise<{ id: string; name: string; image: string | null } | null> {
  const rows = await dbAll(
    db
      .select({ id: schema.user.id, name: schema.user.name, image: schema.user.image })
      .from(schema.user)
      .where(eq(schema.user.id, userId)),
  );
  return (rows[0] as { id: string; name: string; image: string | null } | undefined) ?? null;
}
