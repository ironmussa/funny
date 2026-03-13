/**
 * Project + membership routes for the central server.
 *
 * Project CRUD (list, create, get, update, delete) is proxied to the runner
 * since the Runtime owns the project schema. The Server only manages
 * team-specific data (membership, local paths).
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import * as pm from '../services/project-manager.js';

export const projectRoutes = new Hono<ServerEnv>();

// ── Project CRUD — proxied to runner ─────────────────────

/** List all projects — proxied to the runner */
projectRoutes.get('/', proxyToRunner);

/** Create a new project — proxied to the runner */
projectRoutes.post('/', proxyToRunner);

/** Get a single project — proxied to the runner */
projectRoutes.get('/:id', proxyToRunner);

/** Update a project — proxied to the runner */
projectRoutes.put('/:id', proxyToRunner);

/** Delete a project — proxied to the runner */
projectRoutes.delete('/:id', proxyToRunner);

/** Get project branches — proxied to the runner */
projectRoutes.get('/:id/branches', proxyToRunner);

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
