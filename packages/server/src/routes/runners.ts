/**
 * @domain subdomain: Runner Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * HTTP endpoints for runner registration, heartbeat, task polling,
 * project assignment, and management.
 */

import type {
  RunnerRegisterRequest,
  RunnerHeartbeatRequest,
  RunnerTaskResultRequest,
  AssignProjectRequest,
} from '@funny/shared/runner-protocol';
import { Hono } from 'hono';

import * as rm from '../services/runner-manager.js';

export const runnerRoutes = new Hono();

// ── Registration ────────────────────────────────────────

runnerRoutes.post('/register', async (c) => {
  const body = await c.req.json<RunnerRegisterRequest>();

  if (!body.name || !body.hostname || !body.os) {
    return c.json({ error: 'Missing required fields: name, hostname, os' }, 400);
  }

  const result = await rm.registerRunner(body);
  return c.json(result, 201);
});

// ── Heartbeat ───────────────────────────────────────────

runnerRoutes.post('/heartbeat', async (c) => {
  const runnerId = await getRunnerIdFromAuth(c);
  if (!runnerId) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<RunnerHeartbeatRequest>();
  await rm.handleHeartbeat(runnerId, body);
  return c.json({ ok: true });
});

// ── Task Polling ────────────────────────────────────────

runnerRoutes.get('/tasks', async (c) => {
  const runnerId = await getRunnerIdFromAuth(c);
  if (!runnerId) return c.json({ error: 'Unauthorized' }, 401);

  const tasks = await rm.getPendingTasks(runnerId);
  return c.json({ tasks });
});

// ── Task Result ─────────────────────────────────────────

runnerRoutes.post('/tasks/result', async (c) => {
  const runnerId = await getRunnerIdFromAuth(c);
  if (!runnerId) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<RunnerTaskResultRequest>();
  await rm.completeTask(body);
  return c.json({ ok: true });
});

// ── Runner Listing (admin) ──────────────────────────────

runnerRoutes.get('/', async (c) => {
  const allRunners = await rm.listRunners();
  return c.json({ runners: allRunners });
});

// ── Single Runner ───────────────────────────────────────

runnerRoutes.get('/:runnerId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const runner = await rm.getRunner(runnerId);
  if (!runner) return c.json({ error: 'Runner not found' }, 404);
  return c.json(runner);
});

// ── Remove Runner (admin) ───────────────────────────────

runnerRoutes.delete('/:runnerId', async (c) => {
  const runnerId = c.req.param('runnerId');
  await rm.removeRunner(runnerId);
  return c.json({ ok: true });
});

// ── Project Assignment (admin) ──────────────────────────

/**
 * Assign a project to a runner.
 * The admin specifies the local path on the runner machine where the repo lives.
 */
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

/**
 * List all project assignments for a runner.
 */
runnerRoutes.get('/:runnerId/projects', async (c) => {
  const runnerId = c.req.param('runnerId');

  const runner = await rm.getRunner(runnerId);
  if (!runner) return c.json({ error: 'Runner not found' }, 404);

  const assignments = await rm.listAssignments(runnerId);
  return c.json({ assignments });
});

/**
 * Unassign a project from a runner.
 */
runnerRoutes.delete('/:runnerId/projects/:projectId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const projectId = c.req.param('projectId');

  await rm.unassignProject(runnerId, { projectId });
  return c.json({ ok: true });
});

// ── Helper ──────────────────────────────────────────────

async function getRunnerIdFromAuth(c: any): Promise<string | null> {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return rm.authenticateRunner(token);
}
