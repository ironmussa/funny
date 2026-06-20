/**
 * Thread sharing routes for the central server.
 *
 * Identity-gated, per-thread read+comment grants. The owner shares a thread
 * with a SPECIFIC co-member of their active organization; access is then
 * decided by the grant table (see middleware/thread-access.ts → canViewThread),
 * never by a link/token. Split out of routes/threads.ts to keep that file
 * focused; mounted at `/api/threads` BEFORE `threadRoutes` so `/shared-with-me`
 * is not captured by the `/:id` pattern.
 */

import { createThreadShareRepository } from '@funny/shared/repositories';
import {
  THREAD_SHARE_GRANTED_EVENT,
  THREAD_SHARE_REVOKED_EVENT,
} from '@funny/shared/socket-events';
import { inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db, dbAll, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { ServerEnv } from '../lib/types.js';
import { isProjectMember } from '../services/project-manager.js';
import { evictUserFromThread, relayToUser } from '../services/ws-relay.js';
import { parseJsonBody } from '../validation/request.js';
import { requireThreadOwner } from './threads.js';

const shareRepo = createThreadShareRepository({ db, schema: schema as any, dbAll, dbRun });

export const shareRoutes = new Hono<ServerEnv>();

const createThreadShareSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  level: z.unknown().optional(),
});

// GET /api/threads/shared-with-me — threads other users have shared TO the
// caller. Backs the "Shared with me" nav bucket. Returns only the caller's own
// grants, so no per-thread access check is needed. MUST be registered before
// `/:id` (handled by mounting shareRoutes ahead of threadRoutes in index.ts).
shareRoutes.get('/shared-with-me', async (c) => {
  const userId = c.get('userId') as string;
  const threads = await shareRepo.listThreadsSharedWithUser(userId);
  return c.json({ threads });
});

// POST /api/threads/:id/shares — grant a specific org member read+comment access
shareRoutes.post('/:id/shares', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const ownerId = c.get('userId') as string;
  const thread = c.get('thread');

  const parsed = await parseJsonBody(c, createThreadShareSchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;
  const targetUserId = body.userId.trim();
  if (!targetUserId) {
    return c.json({ error: 'userId is required' }, 400);
  }
  // Share level: 'view' (read), 'comment' (read + comment), or 'steer' (read +
  // comment + follow-ups / edit). Anything else (incl. omitted) falls back to
  // the safe default 'view'. Maps to canonical viewer/commenter/contributor.
  const level: 'view' | 'comment' | 'steer' =
    body.level === 'steer' ? 'steer' : body.level === 'comment' ? 'comment' : 'view';
  if (targetUserId === ownerId) {
    return c.json({ error: 'Cannot share a thread with yourself', code: 'share-self' }, 400);
  }

  // Sharing is scoped to the thread's PROJECT: the target MUST be a member of
  // it. Scratch threads have no project, so there is no audience to share with.
  const projectId = thread?.projectId;
  if (!projectId) {
    return c.json(
      { error: 'This thread has no project to share within', code: 'share-no-project' },
      400,
    );
  }
  if (!(await isProjectMember(projectId, targetUserId))) {
    return c.json(
      { error: 'User is not a member of this project', code: 'share-target-not-in-project' },
      400,
    );
  }

  const grant = await shareRepo.createShare({
    threadId: id,
    sharedWithUserId: targetUserId,
    sharedByUserId: ownerId,
    level,
  });
  // Push the thread into the target's "Shared with me" bucket live (no reload).
  if (!grant.alreadyExisted) {
    relayToUser(targetUserId, { type: THREAD_SHARE_GRANTED_EVENT, threadId: id });
  }
  return c.json(grant, grant.alreadyExisted ? 200 : 201);
});

// GET /api/threads/:id/shares — list current grants with invited-user display info
shareRoutes.get('/:id/shares', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const shares = await shareRepo.listSharesForThread(id);
  if (shares.length === 0) return c.json([]);

  const userIds = shares.map((s: any) => s.sharedWithUserId);
  const users = await dbAll(
    db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        image: schema.user.image,
        username: schema.user.username,
      })
      .from(schema.user)
      .where(inArray(schema.user.id, userIds)),
  );
  const byId = new Map(users.map((u: any) => [u.id, u]));

  return c.json(
    shares.map((s: any) => ({
      threadId: s.threadId,
      sharedWithUserId: s.sharedWithUserId,
      sharedByUserId: s.sharedByUserId,
      level: s.level === 'steer' ? 'steer' : s.level === 'comment' ? 'comment' : 'view',
      createdAt: s.createdAt,
      user: byId.get(s.sharedWithUserId) ?? null,
    })),
  );
});

// DELETE /api/threads/:id/shares/:userId — revoke a grant
shareRoutes.delete('/:id/shares/:userId', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');
  await shareRepo.deleteShare(id, targetUserId);

  // Live eviction: drop the revoked user's sockets from the thread's rooms so
  // they stop receiving the stream/presence immediately, and tell their client
  // to drop the thread. Access already fails closed on their next HTTP request.
  evictUserFromThread(targetUserId, id);
  relayToUser(targetUserId, { type: THREAD_SHARE_REVOKED_EVENT, threadId: id });

  return c.json({ ok: true });
});
