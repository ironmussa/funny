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
import type { ServerEnv } from '../lib/types.js';
import { requirePermission } from '../middleware/auth.js';

export const teamProjectRoutes = new Hono<ServerEnv>();

// GET /api/team-projects — list full Project objects associated with the active org
teamProjectRoutes.get('/', async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json([], 200);

  // Inline pm.listProjectsByOrg replacement
  const items = await db
    .select({
      project: schema.projects,
    })
    .from(schema.teamProjects)
    .innerJoin(schema.projects, eq(schema.teamProjects.projectId, schema.projects.id))
    .where(eq(schema.teamProjects.teamId, orgId));

  const projects = items.map((i) => i.project);
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
