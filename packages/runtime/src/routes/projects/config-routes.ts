import { Hono } from 'hono';
import { z } from 'zod';

import * as pc from '../../services/project-config-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireProject } from '../../utils/route-helpers.js';
import { parseJsonBody } from '../../validation/request.js';

export const projectConfigRoutes = new Hono<HonoEnv>();

const projectConfigSchema = z.object({
  envFiles: z.array(z.string()).optional(),
  portGroups: z
    .array(
      z.object({
        name: z.string().min(1),
        basePort: z.number().int(),
        envVars: z.array(z.string()),
      }),
    )
    .optional(),
  postCreate: z.array(z.string()).optional(),
});

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

  const parsed = await parseJsonBody(c, projectConfigSchema);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  pc.updateConfig(projectResult.value.path, parsed.value);
  return c.json({ ok: true });
});
