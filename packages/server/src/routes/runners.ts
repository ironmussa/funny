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

    // If this is a user-authenticated request, associate runner with user
    const userId = c.get('userId') as string | undefined;
    const result = await rm.registerRunner(body, userId);
    return c.json(result, 201);
  } catch (err: any) {
    const message = err?.message || String(err);
    const cause = err?.cause?.message || err?.cause || '';
    const code = err?.code || err?.cause?.code || '';
    log.error('Runner registration failed', {
      namespace: 'runner',
      error: message,
      cause: String(cause),
      code: String(code),
      stack: err?.stack?.split('\n').slice(0, 5).join(' | ') || '',
    });
    return c.json({ error: `Registration failed: ${message}` }, 500);
  }
});

// ── Heartbeat ───────────────────────────────────────────

runnerRoutes.post('/heartbeat', async (c) => {
  const runnerId = c.get('runnerId') as string | undefined;
  if (!runnerId) return c.json({ error: 'Unauthorized: runner token required' }, 401);

  const body = await c.req.json<RunnerHeartbeatRequest>();
  await rm.handleHeartbeat(runnerId, body);
  return c.json({ ok: true });
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

// ── Runner Listing (admin) ──────────────────────────────

runnerRoutes.get('/', async (c) => {
  const allRunners = await rm.listRunners();
  return c.json({ runners: allRunners });
});

runnerRoutes.get('/:runnerId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const runner = await rm.getRunner(runnerId);
  if (!runner) return c.json({ error: 'Runner not found' }, 404);
  return c.json(runner);
});

runnerRoutes.delete('/:runnerId', async (c) => {
  const runnerId = c.req.param('runnerId');
  await rm.removeRunner(runnerId);
  return c.json({ ok: true });
});

// ── Project Assignment ──────────────────────────────────

runnerRoutes.post('/:runnerId/projects', async (c) => {
  const runnerId = c.req.param('runnerId');
  const body = await c.req.json<AssignProjectRequest>();

  if (!body.projectId || !body.localPath) {
    return c.json({ error: 'Missing required fields: projectId, localPath' }, 400);
  }

  const runner = await rm.getRunner(runnerId);
  if (!runner) return c.json({ error: 'Runner not found' }, 404);

  const assignment = await rm.assignProject(runnerId, body);
  return c.json(assignment, 201);
});

runnerRoutes.get('/:runnerId/projects', async (c) => {
  const runnerId = c.req.param('runnerId');

  const runner = await rm.getRunner(runnerId);
  if (!runner) return c.json({ error: 'Runner not found' }, 404);

  const assignments = await rm.listAssignments(runnerId);
  return c.json({ assignments });
});

runnerRoutes.delete('/:runnerId/projects/:projectId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const projectId = c.req.param('projectId');

  await rm.unassignProject(runnerId, { projectId });
  return c.json({ ok: true });
});
