import { Hono } from 'hono';

import * as pc from '../../services/project-config-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireProject } from '../../utils/route-helpers.js';

export const projectConfigRoutes = new Hono<HonoEnv>();

// GET /api/projects/:id/config
projectConfigRoutes.get('/:id/config', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const config = pc.getConfig(projectResult.value.path);
  return c.json(config);
});

// PUT /api/projects/:id/config
projectConfigRoutes.put('/:id/config', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const body = await c.req.json();
  pc.updateConfig(projectResult.value.path, body);
  return c.json({ ok: true });
});
