import { Hono } from 'hono';

import * as ph from '../../services/project-hooks-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireProject } from '../../utils/route-helpers.js';
import {
  createHookSchema,
  reorderHooksSchema,
  updateHookSchema,
  validate,
} from '../../validation/schemas.js';

export const projectHooksRoutes = new Hono<HonoEnv>();

// GET /api/projects/:id/hooks
projectHooksRoutes.get('/:id/hooks', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const hookType = c.req.query('hookType') as import('@funny/shared').HookType | undefined;
  const hooks = ph.listHooks(projectResult.value.path, hookType);
  return c.json(hooks);
});

// POST /api/projects/:id/hooks — add a command
projectHooksRoutes.post('/:id/hooks', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const raw = await c.req.json();
  const parsed = validate(createHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const { hookType, label, command } = parsed.value;
  const entry = ph.addCommand(projectResult.value.path, hookType, label, command);
  return c.json(entry, 201);
});

// PUT /api/projects/:id/hooks/reorder
projectHooksRoutes.put('/:id/hooks/reorder', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const raw = await c.req.json();
  const parsed = validate(reorderHooksSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  ph.reorderCommands(projectResult.value.path, parsed.value.hookType, parsed.value.newOrder);
  return c.json({ ok: true });
});

// PUT /api/projects/:id/hooks/:hookType/:index — update a command
projectHooksRoutes.put('/:id/hooks/:hookType/:index', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const hookType = c.req.param('hookType') as import('@funny/shared').HookType;
  const index = parseInt(c.req.param('index'), 10);

  const raw = await c.req.json();
  const parsed = validate(updateHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  try {
    ph.updateCommand(projectResult.value.path, hookType, index, parsed.value);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Update failed';
    return c.json({ error: message }, 404);
  }
});

// DELETE /api/projects/:id/hooks/:hookType/:index — delete a command
projectHooksRoutes.delete('/:id/hooks/:hookType/:index', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const hookType = c.req.param('hookType') as import('@funny/shared').HookType;
  const index = parseInt(c.req.param('index'), 10);

  try {
    ph.deleteCommand(projectResult.value.path, hookType, index);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Delete failed';
    return c.json({ error: message }, 404);
  }
});
