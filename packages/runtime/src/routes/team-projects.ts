/**
 * @domain subdomain: Team Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import { eq, and } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, schema, dbGet, dbRun } from '../db/index.js';
import { requirePermission } from '../middleware/auth.js';
import * as pm from '../services/project-manager.js';
import type { HonoEnv } from '../types/hono-env.js';

export const teamProjectRoutes = new Hono<HonoEnv>();

// GET /api/team-projects — list full Project objects associated with the active org
teamProjectRoutes.get('/', async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json([], 200);

  const projects = await pm.listProjectsByOrg(orgId);
  return c.json(projects.map((p) => ({ ...p, isTeamProject: true })));
});

// POST /api/team-projects — associate a project with the active org
teamProjectRoutes.post('/', requirePermission('project', 'create'), async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'No active organization' }, 400);

  const body = await c.req.json<{ projectId: string }>();
  if (!body.projectId) return c.json({ error: 'projectId is required' }, 400);

  // Verify project exists
  const project = await dbGet(
    db.select().from(schema.projects).where(eq(schema.projects.id, body.projectId)),
  );

  if (!project) return c.json({ error: 'Project not found' }, 404);

  // Check if association already exists
  const existing = await dbGet(
    db
      .select()
      .from(schema.teamProjects)
      .where(
        and(
          eq(schema.teamProjects.teamId, orgId),
          eq(schema.teamProjects.projectId, body.projectId),
        ),
      ),
  );

  if (existing) return c.json({ error: 'Project already associated with this team' }, 409);

  await dbRun(
    db.insert(schema.teamProjects).values({
      teamId: orgId,
      projectId: body.projectId,
      createdAt: new Date().toISOString(),
    }),
  );

  return c.json({ teamId: orgId, projectId: body.projectId }, 201);
});

// DELETE /api/team-projects/:projectId — disassociate a project from the active org
teamProjectRoutes.delete('/:projectId', requirePermission('project', 'delete'), async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'No active organization' }, 400);

  const projectId = c.req.param('projectId');

  await dbRun(
    db
      .delete(schema.teamProjects)
      .where(
        and(eq(schema.teamProjects.teamId, orgId), eq(schema.teamProjects.projectId, projectId)),
      ),
  );

  return c.json({ ok: true });
});
