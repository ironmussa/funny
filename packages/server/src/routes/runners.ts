/**
 * Runner management routes for the central server.
 */

import type {
  RunnerRegisterRequest,
  RunnerHeartbeatRequest,
  RunnerTaskResultRequest,
  AssignProjectRequest,
} from '@funny/shared/runner-protocol';
import { Hono } from 'hono';

import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import * as rm from '../services/runner-manager.js';

export const runnerRoutes = new Hono<ServerEnv>();

// ── Registration ────────────────────────────────────────

runnerRoutes.post('/register', async (c) => {
  try {
    const body = await c.req.json<RunnerRegisterRequest>();

    if (!body.name || !body.hostname || !body.os) {
      return c.json({ error: 'Missing required fields: name, hostname, os' }, 400);
    }

    // Runner MUST be associated with a user for tenant isolation
    const userId = c.get('userId') as string | undefined;
    log.warn('Runner registration: userId from context', {
      namespace: 'runner',
      userId: userId ?? '(undefined)',
      isRunner: c.get('isRunner'),
    });
    if (!userId) {
      log.error('Runner registration rejected — no userId in context', { namespace: 'runner' });
      return c.json({ error: 'Runner must be associated with a user' }, 400);
    }
    const result = await rm.registerRunner(body, userId);
    audit({
      action: 'runner.register',
      actorId: userId,
      detail: `Runner "${body.name}" registered`,
      meta: { runnerId: result.runnerId, hostname: body.hostname, os: body.os },
    });
    return c.json(result, 201);
  } catch (err: any) {
    // Full diagnostics go to the structured logger only — never to the client.
    // Returning err.message risks leaking DB paths, internal codes, or stack
    // fragments embedded in driver errors.
    log.error('Runner registration failed', {
      namespace: 'runner',
      error: err?.message || String(err),
      cause: String(err?.cause?.message || err?.cause || ''),
      code: String(err?.code || err?.cause?.code || ''),
      stack: err?.stack?.split('\n').slice(0, 5).join(' | ') || '',
    });
    return c.json({ error: 'Registration failed' }, 500);
  }
});

// ── Heartbeat ───────────────────────────────────────────

runnerRoutes.post('/heartbeat', async (c) => {
  const runnerId = c.get('runnerId') as string | undefined;
  if (!runnerId) return c.json({ error: 'Unauthorized: runner token required' }, 401);

  const body = await c.req.json<RunnerHeartbeatRequest>();
  const exists = await rm.handleHeartbeat(runnerId, body);
  if (!exists) {
    return c.json(
      { error: 'Runner not found — re-register required', code: 'RUNNER_NOT_FOUND' },
      404,
    );
  }

  // Tell the runner whether its WS tunnel is connected from the server's perspective.
  // This lets the runner detect stale connections (e.g. after server restart).
  const { isRunnerConnected } = await import('../services/ws-relay.js');
  return c.json({ ok: true, wsConnected: isRunnerConnected(runnerId) });
});

// ── Task Polling ────────────────────────────────────────

runnerRoutes.get('/tasks', async (c) => {
  const runnerId = c.get('runnerId') as string | undefined;
  if (!runnerId) return c.json({ error: 'Unauthorized: runner token required' }, 401);

  const tasks = await rm.getPendingTasks(runnerId);
  return c.json({ tasks });
});

// ── Task Result ─────────────────────────────────────────

runnerRoutes.post('/tasks/result', async (c) => {
  const runnerId = c.get('runnerId') as string | undefined;
  if (!runnerId) return c.json({ error: 'Unauthorized: runner token required' }, 401);

  const body = await c.req.json<RunnerTaskResultRequest>();
  await rm.completeTask(body);
  return c.json({ ok: true });
});

// ── Runner Listing ──────────────────────────────────────

runnerRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string | undefined;
  const isRunner = c.get('isRunner') as boolean | undefined;
  const userRole = c.get('userRole') as string | undefined;

  // Admins and runner-authenticated requests see all runners
  if (isRunner || userRole === 'admin') {
    return c.json({ runners: await rm.listRunners() });
  }

  // Regular users see only their own runners
  if (userId) {
    return c.json({ runners: await rm.listRunnersByUser(userId) });
  }

  return c.json({ runners: [] });
});

runnerRoutes.get('/:runnerId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const userId = c.get('userId') as string | undefined;
  const isRunner = c.get('isRunner') as boolean | undefined;
  const userRole = c.get('userRole') as string | undefined;

  const runner = await rm.getRunner(runnerId);
  if (!runner) return c.json({ error: 'Runner not found' }, 404);

  // Tenant isolation: only the owner, an admin, or a runner-authenticated
  // caller (server-to-runner) may view a runner record. Otherwise return
  // 404 rather than 403 so we don't disclose the runner's existence.
  const isAdmin = userRole === 'admin';
  const ownerId = await rm.getRunnerUserId(runnerId);
  const isOwner = !!userId && ownerId === userId;
  if (!isRunner && !isAdmin && !isOwner) {
    audit({
      action: 'authz.cross_tenant_refused',
      actorId: userId ?? null,
      detail: 'GET /api/runners/:runnerId refused for non-owner',
      meta: { runnerId, ownerId: ownerId ?? null },
    });
    return c.json({ error: 'Runner not found' }, 404);
  }

  return c.json(runner);
});

runnerRoutes.delete('/:runnerId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const userId = c.get('userId') as string | undefined;
  const userRole = c.get('userRole') as string | undefined;

  if (userRole === 'admin') {
    await rm.removeRunner(runnerId);
    audit({
      action: 'runner.remove',
      actorId: userId ?? null,
      detail: `Admin removed runner`,
      meta: { runnerId },
    });
    return c.json({ ok: true });
  }

  if (userId) {
    const removed = await rm.removeRunnerForUser(runnerId, userId);
    if (!removed) return c.json({ error: 'Runner not found or not owned by you' }, 404);
    audit({
      action: 'runner.remove',
      actorId: userId,
      detail: `User removed own runner`,
      meta: { runnerId },
    });
    return c.json({ ok: true });
  }

  return c.json({ error: 'Unauthorized' }, 401);
});

// ── Project Assignment ──────────────────────────────────

/**
 * Return true when the caller is the runner's owner, an admin, or a
 * runner-authenticated (server-to-runner) request. Callers that fail this
 * check should 404 (not 403) so we don't leak a runner's existence to
 * other tenants — matches the `GET /:runnerId` behaviour.
 */
async function authorizeRunnerAccess(runnerId: string, c: any): Promise<boolean> {
  const userId = c.get('userId') as string | undefined;
  const isRunner = c.get('isRunner') as boolean | undefined;
  const userRole = c.get('userRole') as string | undefined;
  if (isRunner) return true;
  if (userRole === 'admin') return true;
  if (!userId) {
    audit({
      action: 'authz.cross_tenant_refused',
      actorId: null,
      detail: 'Runner access refused — no userId on request',
      meta: { runnerId, path: c.req.path, method: c.req.method },
    });
    return false;
  }
  const ownerId = await rm.getRunnerUserId(runnerId);
  const isOwner = ownerId === userId;
  if (!isOwner) {
    audit({
      action: 'authz.cross_tenant_refused',
      actorId: userId,
      detail: 'Runner access refused — non-owner',
      meta: { runnerId, ownerId: ownerId ?? null, path: c.req.path, method: c.req.method },
    });
  }
  return isOwner;
}

runnerRoutes.post('/:runnerId/projects', async (c) => {
  const runnerId = c.req.param('runnerId');
  const body = await c.req.json<AssignProjectRequest>();

  if (!body.projectId || !body.localPath) {
    return c.json({ error: 'Missing required fields: projectId, localPath' }, 400);
  }

  const runner = await rm.getRunner(runnerId);
  if (!runner || !(await authorizeRunnerAccess(runnerId, c))) {
    return c.json({ error: 'Runner not found' }, 404);
  }

  const assignment = await rm.assignProject(runnerId, body);
  return c.json(assignment, 201);
});

runnerRoutes.get('/:runnerId/projects', async (c) => {
  const runnerId = c.req.param('runnerId');

  const runner = await rm.getRunner(runnerId);
  if (!runner || !(await authorizeRunnerAccess(runnerId, c))) {
    return c.json({ error: 'Runner not found' }, 404);
  }

  const assignments = await rm.listAssignments(runnerId);
  return c.json({ assignments });
});

runnerRoutes.delete('/:runnerId/projects/:projectId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const projectId = c.req.param('projectId');

  const runner = await rm.getRunner(runnerId);
  if (!runner || !(await authorizeRunnerAccess(runnerId, c))) {
    return c.json({ error: 'Runner not found' }, 404);
  }

  await rm.unassignProject(runnerId, { projectId });
  return c.json({ ok: true });
});
