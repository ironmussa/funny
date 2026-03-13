/**
 * Project + membership routes for the central server.
 * This is the source of truth for team projects.
 */

import { Hono } from 'hono';

import * as pm from '../services/project-manager.js';

export const projectRoutes = new Hono();

// ── Project CRUD ─────────────────────────────────────────

/** List all projects the authenticated user is a member of */
projectRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const projects = await pm.listProjectsForUser(userId);
  return c.json({ projects });
});

/** Create a new project */
projectRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json<{
    name: string;
    repoUrl: string;
    description?: string;
    organizationId?: string;
  }>();

  if (!body.name || !body.repoUrl) {
    return c.json({ error: 'Missing required fields: name, repoUrl' }, 400);
  }

  const project = await pm.createProject(userId, body);
  return c.json(project, 201);
});

/** Get a single project */
projectRoutes.get('/:id', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  if (!(await pm.isProjectMember(projectId, userId))) {
    return c.json({ error: 'Not a member of this project' }, 403);
  }

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  return c.json(project);
});

/** Update a project */
projectRoutes.put('/:id', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  if (!(await pm.isProjectMember(projectId, userId))) {
    return c.json({ error: 'Not a member of this project' }, 403);
  }

  const body = await c.req.json<{ name?: string; repoUrl?: string; description?: string }>();
  const updated = await pm.updateProject(projectId, body);
  if (!updated) return c.json({ error: 'Project not found' }, 404);
  return c.json(updated);
});

/** Delete a project */
projectRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  // Only project admins can delete
  const members = await pm.listMembers(projectId);
  const userMember = members.find((m) => m.userId === userId);
  if (!userMember || userMember.role !== 'admin') {
    return c.json({ error: 'Only project admins can delete projects' }, 403);
  }

  await pm.deleteProject(projectId);
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

/** Runner reports local path for a project */
projectRoutes.post('/:id/local-path', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  const body = await c.req.json<{ localPath: string }>();
  if (!body.localPath) {
    return c.json({ error: 'Missing required field: localPath' }, 400);
  }

  await pm.setMemberLocalPath(projectId, userId, body.localPath);
  return c.json({ ok: true });
});
