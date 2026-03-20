/**
 * Arc routes for the central server.
 *
 * DB CRUD (list, create, delete) is handled natively.
 * Artifact reading falls through to the runtime via the catch-all proxy.
 *
 * Two route groups are exported:
 * - arcProjectRoutes: mounted under /api/projects (list/create arcs under a project)
 * - arcRoutes: mounted under /api/arcs (operations by arc ID)
 */

import { createArcRepository } from '@funny/shared/repositories';
import { Hono } from 'hono';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { ServerEnv } from '../lib/types.js';
import * as projectRepo from '../services/project-repository.js';

const arcRepo = createArcRepository({ db, schema: schema as any, dbAll, dbGet, dbRun });

// ── Routes nested under /api/projects/:id/arcs ──────────────────

export const arcProjectRoutes = new Hono<ServerEnv>();

// GET /api/projects/:id/arcs — list arcs for a project
arcProjectRoutes.get('/:id/arcs', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');

  const project = await projectRepo.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  if (project.userId !== userId) {
    if (!orgId || !(await projectRepo.isProjectInOrg(projectId, orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }
  }

  const arcs = await arcRepo.listArcs(projectId, userId);
  return c.json(arcs);
});

// POST /api/projects/:id/arcs — create a new arc
arcProjectRoutes.post('/:id/arcs', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');

  const project = await projectRepo.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  if (project.userId !== userId) {
    if (!orgId || !(await projectRepo.isProjectInOrg(projectId, orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }
  }

  const { name } = await c.req.json<{ name: string }>();
  if (!name) return c.json({ error: 'name is required' }, 400);

  // Validate kebab-case
  const kebabRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  if (!kebabRegex.test(name) || name.length > 100) {
    return c.json({ error: 'name must be kebab-case (e.g., "add-caching"), max 100 chars' }, 400);
  }

  // Check for duplicates
  const exists = await arcRepo.arcNameExists(projectId, userId, name);
  if (exists) {
    return c.json({ error: `Arc "${name}" already exists in this project` }, 409);
  }

  const arc = await arcRepo.createArc({ projectId, userId, name });
  return c.json(arc, 201);
});

// ── Routes at /api/arcs/:id ─────────────────────────────────────

export const arcRoutes = new Hono<ServerEnv>();

// GET /api/arcs/:id — get arc details
arcRoutes.get('/:id', async (c) => {
  const arcId = c.req.param('id');
  const userId = c.get('userId') as string;

  const arc = await arcRepo.getArc(arcId);
  if (!arc) return c.json({ error: 'Arc not found' }, 404);
  if (arc.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  return c.json(arc);
});

// DELETE /api/arcs/:id — delete an arc, unlink threads
arcRoutes.delete('/:id', async (c) => {
  const arcId = c.req.param('id');
  const userId = c.get('userId') as string;

  const arc = await arcRepo.getArc(arcId);
  if (!arc) return c.json({ error: 'Arc not found' }, 404);
  if (arc.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  await arcRepo.deleteArc(arcId);
  return c.json({ ok: true });
});

// GET /api/arcs/:id/threads — list threads linked to an arc
arcRoutes.get('/:id/threads', async (c) => {
  const arcId = c.req.param('id');
  const userId = c.get('userId') as string;

  const arc = await arcRepo.getArc(arcId);
  if (!arc) return c.json({ error: 'Arc not found' }, 404);
  if (arc.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  const threads = await arcRepo.listArcThreads(arcId);
  return c.json(threads);
});
