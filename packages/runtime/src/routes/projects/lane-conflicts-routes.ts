/**
 * The issue factory's cross-lane conflict check (openspec factory-lanes D7).
 *
 * POST /api/projects/:id/lane-conflicts  { branches: string[] }
 *
 * Fetches, then tries `git merge-tree` on each pair of `origin/<branch>` in
 * the project's checkout. It writes no branch, no worktree and no index: the
 * fetch only moves remote-tracking refs. With git older than 2.38 it answers
 * `{ kind: 'unavailable' }` instead of guessing.
 */

import { checkBranchConflicts } from '@funny/core/git';
import { Hono } from 'hono';

import { resolveIdentity } from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireProject } from '../../utils/route-helpers.js';
import { laneConflictsSchema, validate } from '../../validation/schemas.js';

export const projectLaneConflictRoutes = new Hono<HonoEnv>();

projectLaneConflictRoutes.post('/:id/lane-conflicts', async (c) => {
  const userId = c.get('userId');
  const projectResult = await requireProject(
    c.req.param('id'),
    userId,
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const body = await c.req.json().catch(() => ({}));
  const parsed = validate(laneConflictsSchema, body);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const identity = userId ? await resolveIdentity(userId, project.id) : undefined;
  const report = await checkBranchConflicts(project.path, parsed.value.branches, identity);
  return resultToResponse(c, report);
});
