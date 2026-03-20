/**
 * Project + membership routes for the central server.
 *
 * Project CRUD (list, create, get, update, delete, reorder) is handled here
 * because these are server-only concerns (DB writes). Filesystem/git operations
 * (branches, checkout-preflight, commands, hooks, weave) fall through to the
 * catch-all proxy in index.ts which forwards them to the runner.
 */

import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import * as pm from '../services/project-manager.js';
import * as projectRepo from '../services/project-repository.js';

export const projectRoutes = new Hono<ServerEnv>();

// ── Project CRUD ─────────────────────────────────────────

/** GET /api/projects — list projects for the current user */
projectRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const isPersonal = c.req.query('personal') === 'true';
  const queryOrgId = c.req.query('orgId');
  const sessionOrgId = c.get('organizationId');

  const orgId = isPersonal ? null : queryOrgId || sessionOrgId;

  if (orgId) {
    const teamProjects = await projectRepo.listProjectsByOrg(orgId);
    const organizationName = c.get('organizationName') || undefined;
    const sharedProjects = teamProjects.filter((p) => p.userId !== userId);
    const localPaths = await Promise.all(
      sharedProjects.map((p) => projectRepo.getMemberLocalPath(p.id, userId)),
    );
    const localPathByProject = new Map(sharedProjects.map((p, i) => [p.id, localPaths[i]]));

    const result = teamProjects.map((p) => {
      if (p.userId === userId) {
        return { ...p, isTeamProject: true as const, organizationName };
      }
      const lp = localPathByProject.get(p.id) ?? null;
      return {
        ...p,
        isTeamProject: true as const,
        organizationName,
        localPath: lp ?? undefined,
        needsSetup: !lp,
      };
    });
    return c.json(result);
  }

  const projects = await projectRepo.listProjects(userId);
  // Exclude projects that belong to any organization
  const orgProjectIds = await projectRepo.getOrgProjectIds();
  const personalProjects =
    orgProjectIds.length > 0 ? projects.filter((p) => !orgProjectIds.includes(p.id)) : projects;
  return c.json(personalProjects);
});

/** GET /api/projects/resolve — find project by URL pattern */
projectRoutes.get('/resolve', async (c) => {
  const userId = c.get('userId') as string;
  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'Missing required query parameter: url' }, 400);
  }

  const projects = await projectRepo.listProjects(userId);
  const matched = projects.find((p) => p.urls?.some((pattern) => url.startsWith(pattern)));

  if (matched) {
    return c.json({ project: matched, source: 'url_match' });
  }
  return c.json({ project: null, source: 'none' });
});

/** POST /api/projects — create a new project */
projectRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const raw = await c.req.json();
  const { name, path } = raw as { name?: string; path?: string };

  if (!name || !path) {
    return c.json({ error: 'name and path are required' }, 400);
  }

  // Duplicate name check
  const nameExists = await projectRepo.projectNameExists(name, userId, orgId);
  if (nameExists) {
    return c.json({ error: `A project named "${name}" already exists` }, 409);
  }

  const result = await projectRepo.createProject(name, path, userId, orgId);

  if (result.isErr()) {
    const e = result.error;
    const status = e.type === 'CONFLICT' ? 409 : e.type === 'BAD_REQUEST' ? 400 : 500;
    return c.json({ error: e.message }, status);
  }

  // Associate with organization
  if (orgId) {
    await projectRepo.addProjectToOrg(result.value.id, orgId);
  }

  return c.json(result.value, 201);
});

/** PATCH /api/projects/:id — update a project */
projectRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');

  // Ownership check
  const project = await projectRepo.getProject(id);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  if (project.userId !== userId) {
    if (!orgId || !(await projectRepo.isProjectInOrg(id, orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }
  }

  const raw = await c.req.json();
  const result = await projectRepo.updateProject(id, raw);

  if (result.isErr()) {
    const e = result.error;
    const status = e.type === 'CONFLICT' ? 409 : e.type === 'NOT_FOUND' ? 404 : 500;
    return c.json({ error: e.message }, status);
  }

  return c.json(result.value);
});

/** DELETE /api/projects/:id — delete a project (owner only) */
projectRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const project = await projectRepo.getProject(id);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  if (project.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  await projectRepo.deleteProject(id);
  return c.json({ ok: true });
});

/** PUT /api/projects/reorder — reorder projects */
projectRoutes.put('/reorder', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const { projectIds } = raw as { projectIds?: string[] };

  if (!projectIds || !Array.isArray(projectIds) || projectIds.length === 0) {
    return c.json({ error: 'projectIds must be a non-empty array' }, 400);
  }

  const result = await projectRepo.reorderProjects(userId, projectIds);
  if (result.isErr()) {
    return c.json({ error: result.error.message }, 500);
  }
  return c.json({ ok: true });
});

// ── Membership ───────────────────────────────────────────

/** List members of a project */
projectRoutes.get('/:id/members', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  if (!(await pm.isProjectMember(projectId, userId))) {
    return c.json({ error: 'Not a member of this project' }, 403);
  }

  const members = await pm.listMembers(projectId);
  return c.json({ members });
});

/** Add a member to a project */
projectRoutes.post('/:id/members', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  // Only admins can add members
  const members = await pm.listMembers(projectId);
  const userMember = members.find((m) => m.userId === userId);
  if (!userMember || userMember.role !== 'admin') {
    return c.json({ error: 'Only project admins can add members' }, 403);
  }

  const body = await c.req.json<{ userId: string; role?: string }>();
  if (!body.userId) {
    return c.json({ error: 'Missing required field: userId' }, 400);
  }

  const member = await pm.addMember(projectId, body.userId, body.role);
  return c.json(member, 201);
});

/** Remove a member from a project */
projectRoutes.delete('/:id/members/:userId', async (c) => {
  const reqUserId = c.get('userId') as string;
  const projectId = c.req.param('id');
  const targetUserId = c.req.param('userId');

  // Only admins can remove members (or self-remove)
  if (reqUserId !== targetUserId) {
    const members = await pm.listMembers(projectId);
    const userMember = members.find((m) => m.userId === reqUserId);
    if (!userMember || userMember.role !== 'admin') {
      return c.json({ error: 'Only project admins can remove members' }, 403);
    }
  }

  await pm.removeMember(projectId, targetUserId);
  return c.json({ ok: true });
});

/** Set local working directory for a shared project (with validation + upsert) */
projectRoutes.post('/:id/local-path', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  const body = await c.req.json<{ localPath: string }>();
  if (!body.localPath) {
    return c.json({ error: 'Missing required field: localPath' }, 400);
  }

  // Validate: must be an absolute path
  if (!isAbsolute(body.localPath)) {
    return c.json({ error: 'Path must be absolute' }, 400);
  }

  const resolvedPath = resolve(body.localPath);

  // Validate: must be a git repository (check for .git directory)
  if (!existsSync(resolve(resolvedPath, '.git'))) {
    return c.json({ error: 'Path is not a git repository' }, 400);
  }

  await pm.setMemberLocalPath(projectId, userId, resolvedPath);
  return c.json({ ok: true });
});
