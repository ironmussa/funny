import type { HookType } from '@funny/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import * as ph from '../../services/project-hooks-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireProject } from '../../utils/route-helpers.js';
import { parseQuery } from '../../validation/request.js';
import {
  createHookSchema,
  hookTypeSchema,
  reorderHooksSchema,
  updateHookSchema,
  validate,
} from '../../validation/schemas.js';

export const projectHooksRoutes = new Hono<HonoEnv>();

/**
 * The project and the `:hookType/:index` command a per-command route acts on, or the
 * error response when the caller cannot access the project.
 */
async function resolveHookCommand(
  c: Context<HonoEnv, '/:id/hooks/:hookType/:index'>,
): Promise<Response | { projectPath: string; hookType: HookType; index: number }> {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  // SAFETY: unchecked route param, used only as the `.husky/<hookType>` file name; an unknown
  // name reads as a missing file with no commands, so the service throws "not found" (404 in
  // the routes below).
  const hookType = c.req.param('hookType') as HookType;
  const index = parseInt(c.req.param('index'), 10);
  return { projectPath: projectResult.value.path, hookType, index };
}

// GET /api/projects/:id/hooks
projectHooksRoutes.get('/:id/hooks', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const query = parseQuery(c, z.object({ hookType: hookTypeSchema.optional() }));
  if (query.isErr()) return resultToResponse(c, query);
  const hooks = ph.listHooks(projectResult.value.path, query.value.hookType);
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
  const target = await resolveHookCommand(c);
  if (target instanceof Response) return target;
  const { projectPath, hookType, index } = target;

  const raw = await c.req.json();
  const parsed = validate(updateHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  try {
    ph.updateCommand(projectPath, hookType, index, parsed.value);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Update failed';
    return c.json({ error: message }, 404);
  }
});

// DELETE /api/projects/:id/hooks/:hookType/:index — delete a command
projectHooksRoutes.delete('/:id/hooks/:hookType/:index', async (c) => {
  const target = await resolveHookCommand(c);
  if (target instanceof Response) return target;
  const { projectPath, hookType, index } = target;

  try {
    ph.deleteCommand(projectPath, hookType, index);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Delete failed';
    return c.json({ error: message }, 404);
  }
});
