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
import { audit } from '../lib/audit.js';
import { authorizer } from '../lib/server-authorizer.js';
import type { ServerEnv } from '../lib/types.js';
import { requirePermission } from '../middleware/auth.js';
import { createProjectsPort } from '../trpc/ports/projects.js';
import { answerJson } from '../trpc/reply.js';

export const teamProjectRoutes = new Hono<ServerEnv>();

// GET /api/team-projects — the active org's projects, answered by the same port
// as `projects.list` with that org: 403 unless the caller is still a member
// (the session's active org outlives a removal), and rows mapped to `Project`.
// Kept on REST with no web client caller (`listTeamProjects` in the client's
// lib/api/team.ts is unused); retire it once nothing outside the app needs it.
teamProjectRoutes.get('/', async (c) => {
  const organizationId = c.get('organizationId');
  if (!organizationId) return c.json([], 200);

  const userId = c.get('userId') as string;
  const port = createProjectsPort(c.get('organizationName'));
  return answerJson(c, port.list({ userId, organizationId }, {}));
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

  // Security C3: linking shares the project with every member of the org (they
  // inherit `viewer` through `team_projects`). Only someone who already manages
  // the project — the owner or a project admin — may make that decision; the
  // org-level `project:create` permission alone is not enough.
  const userId = c.get('userId') as string;
  if (!(await authorizer.authorize(userId, 'project', body.projectId, 'manage'))) {
    audit({
      action: 'authz.cross_tenant_refused',
      actorId: userId,
      detail: 'team-projects link refused — caller cannot manage the project',
      meta: { projectId: body.projectId, orgId },
    });
    return c.json({ error: 'Only the project owner or a project admin can share it' }, 403);
  }

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
  if (!projectId) return c.json({ error: 'Project id required' }, 400);

  await dbRun(
    db
      .delete(schema.teamProjects)
      .where(
        and(eq(schema.teamProjects.teamId, orgId), eq(schema.teamProjects.projectId, projectId)),
      ),
  );

  return c.json({ ok: true });
});
