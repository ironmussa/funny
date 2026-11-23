/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Restore an undo snapshot from the activity panel
 * (track-user-and-scheduled-actions, design D6):
 *   POST /api/git/project/:projectId/undo/:activityId
 *   POST /api/git/:threadId/undo/:activityId
 * The cwd comes from the caller's own project or thread (`requireProjectCwd`
 * / `requireThreadCwd` check ownership). A thread whose agent is running owns
 * its worktree, so a restore there is refused.
 */
import { conflict } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { isAgentRunning } from '../../services/agent-runner-control.js';
import { restoreTracked, threadTarget } from '../../services/git-destructive.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThreadCwd } from '../../utils/route-helpers.js';
import { gitStatusCache, invalidateGitStatusCache, requireProjectCwd } from './helpers.js';

export const undoRoutes = new Hono<HonoEnv>();

undoRoutes.post('/project/:projectId/undo/:activityId', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  const cwdResult = await requireProjectCwd(projectId, userId, c.get('organizationId'));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await restoreTracked(
    { userId, cwd: cwdResult.value, projectId },
    c.req.param('activityId'),
  );
  if (result.isErr()) return resultToResponse(c, result);
  gitStatusCache.delete(projectId);
  return c.json({ ok: true, snapshot: result.value.ref });
});

undoRoutes.post('/:threadId/undo/:activityId', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId');
  const cwdResult = await requireThreadCwd(threadId, userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  if (isAgentRunning(threadId)) {
    return resultToResponse(
      c,
      err(conflict('Stop the agent before restoring: it is using this worktree')),
    );
  }
  const target = await threadTarget(userId, threadId, cwdResult.value);
  const result = await restoreTracked(target, c.req.param('activityId'));
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, snapshot: result.value.ref });
});
