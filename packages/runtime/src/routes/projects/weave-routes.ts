import { ensureWeaveConfigured, getWeaveStatus } from '@funny/core/git';
import { Hono } from 'hono';

import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireProject } from '../../utils/route-helpers.js';

export const projectWeaveRoutes = new Hono<HonoEnv>();

// GET /api/projects/:id/weave/status
projectWeaveRoutes.get('/:id/weave/status', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const result = await getWeaveStatus(projectResult.value.path);
  return resultToResponse(c, result);
});

// POST /api/projects/:id/weave/configure
projectWeaveRoutes.post('/:id/weave/configure', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const result = await ensureWeaveConfigured(projectResult.value.path);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true, status: result.value });
});
