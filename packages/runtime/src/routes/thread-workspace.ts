/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * DELETE /api/threads/:id/scratch (track-funny-actions, design D8): the server
 * asks for it after deleting a scratch thread. The directory is derived from
 * the caller's signed identity (`scratchPathFor(userId, id)`), never from the
 * request, so a caller can only ever remove their own scratch directory. The
 * thread row is usually gone by then; if it still exists it must be the
 * caller's own scratch thread.
 */
import { badRequest, notFound } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { isScratchThread, scratchPathFor } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';
import { removeScratchWorkspace } from '../services/workspace-cleanup.js';
import type { HonoEnv } from '../types/hono-env.js';
import { recordedFailureResponse, resultToResponse } from '../utils/result-response.js';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const threadWorkspaceRoutes = new Hono<HonoEnv>();

threadWorkspaceRoutes.delete('/:id/scratch', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  if (!ID_RE.test(id) || !userId || !ID_RE.test(userId)) {
    return resultToResponse(c, err(badRequest('Invalid thread id')));
  }

  const thread = await tm.getThread(id);
  // Another user's thread answers as if it did not exist.
  if (thread && thread.userId !== userId) return resultToResponse(c, err(notFound('Not found')));
  if (thread && !isScratchThread(thread)) {
    return resultToResponse(c, err(badRequest('Not a scratch thread')));
  }

  const removed = await removeScratchWorkspace({
    userId,
    threadId: id,
    scratchPath: scratchPathFor(userId, id),
  });
  if (removed.isErr()) return recordedFailureResponse(c, removed.error);
  return c.json({ ok: true });
});
