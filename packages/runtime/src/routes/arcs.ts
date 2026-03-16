/**
 * Arc routes for the runtime (runner).
 *
 * Handles filesystem operations: creating arc directories and reading artifacts.
 * DB CRUD is handled by the server package.
 */

import { Hono } from 'hono';

import { createArcDirectory, readArcArtifacts, validateArcName } from '../services/arc-service.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject } from '../utils/route-helpers.js';

// ── Project-scoped routes (mounted at /api/projects) ────────────

export const arcProjectRoutes = new Hono<HonoEnv>();

// POST /api/projects/:id/arcs/directory — create arc directory on the filesystem
arcProjectRoutes.post('/:id/arcs/directory', async (c) => {
  const projectResult = await requireProject(c.req.param('id'));
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const { name } = await c.req.json<{ name: string }>();
  const nameResult = validateArcName(name);
  if (nameResult.isErr()) return c.json({ error: nameResult.error }, 400);

  const dirResult = await createArcDirectory(project.path, name);
  if (dirResult.isErr()) return c.json({ error: dirResult.error }, 500);

  return c.json({ ok: true, path: dirResult.value });
});

// ── Arc-scoped routes (mounted at /api/arcs) ────────────────────

export const arcRoutes = new Hono<HonoEnv>();

// GET /api/arcs/:id/artifacts — read arc artifacts from the filesystem
arcRoutes.get('/:id/artifacts', async (c) => {
  const arcName = c.req.query('name');
  const projectId = c.req.query('projectId');

  if (!arcName || !projectId) {
    return c.json({ error: 'name and projectId query params are required' }, 400);
  }

  const projectResult = await requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const artifacts = await readArcArtifacts(project.path, arcName);
  return c.json({ artifacts });
});
