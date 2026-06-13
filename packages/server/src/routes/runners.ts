/**
 * Runner management routes for the central server.
 */

import type {
  RunnerRegisterRequest,
  RunnerHeartbeatRequest,
  RunnerTaskResultRequest,
  AssignProjectRequest,
  EnrollStartRequest,
  EnrollPollRequest,
  EnrollApproveRequest,
  EnrollPollResponse,
} from '@funny/shared/runner-protocol';
import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';

import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import * as enroll from '../services/runner-enrollment-service.js';
import * as rm from '../services/runner-manager.js';

export const runnerRoutes = new Hono<ServerEnv>();

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

/** Best-effort originating IP of the caller (honors X-Forwarded-For only under TRUST_PROXY). */
function callerIp(c: Context<ServerEnv>): string {
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    const first = xff?.split(',')[0]?.trim();
    if (first) return first;
  }
  try {
    const addr = getConnInfo(c).remote.address;
    if (typeof addr === 'string' && addr.length > 0) return addr;
  } catch {
    // getConnInfo throws when the adapter isn't Bun (e.g. in tests).
  }
  return '';
}

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

// ── Device-Link Enrollment ──────────────────────────────
// start + poll are PUBLIC (a runner has no credentials yet); they are added to
// the public-path allowlist in middleware/auth.ts. approve + the metadata
// lookup run under the normal session auth.

runnerRoutes.post('/enroll/start', async (c) => {
  let body: EnrollStartRequest;
  try {
    body = await c.req.json<EnrollStartRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body?.hostname || !body?.os) {
    return c.json({ error: 'Missing required fields: hostname, os' }, 400);
  }
  const result = await enroll.startEnrollment({
    hostname: String(body.hostname).slice(0, 255),
    os: String(body.os).slice(0, 64),
    ip: callerIp(c),
  });
  return c.json(result, 201);
});

runnerRoutes.post('/enroll/poll', async (c) => {
  let body: EnrollPollRequest;
  try {
    body = await c.req.json<EnrollPollRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body?.pollToken) return c.json({ error: 'Missing pollToken' }, 400);

  const result = await enroll.pollByToken(body.pollToken);
  if (result.status === 'invalid') {
    // Don't leak enrollment state — a bad/expired/consumed token is just 404.
    return c.json({ error: 'Unknown or expired enrollment' }, 404);
  }
  if (result.status === 'pending') {
    return c.json({ status: 'pending' } satisfies EnrollPollResponse);
  }
  return c.json({
    status: 'approved',
    runnerId: result.runnerId,
    token: result.token,
    forwardedSecret: result.forwardedSecret,
  } satisfies EnrollPollResponse);
});

// Authenticated: fetch a pending enrollment's metadata for the confirm dialog.
runnerRoutes.get('/enroll/:userCode', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  const info = await enroll.getByUserCode(c.req.param('userCode'));
  if (!info) return c.json({ error: 'Unknown or expired code' }, 404);
  return c.json(info);
});

// Authenticated: approve a pending enrollment, binding it to this user.
runnerRoutes.post('/enroll/approve', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  let body: EnrollApproveRequest;
  try {
    body = await c.req.json<EnrollApproveRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body?.userCode) return c.json({ error: 'Missing userCode' }, 400);

  const result = await enroll.approve(body.userCode, userId);
  if (!result.ok) {
    const status = result.reason === 'already_approved' ? 409 : 404;
    audit({
      action: 'runner.enroll_rejected',
      actorId: userId,
      detail: `Runner enrollment approval failed: ${result.reason}`,
      meta: { reason: result.reason },
    });
    return c.json({ error: `Enrollment ${result.reason}`, reason: result.reason }, status);
  }
  audit({
    action: 'runner.enroll_approved',
    actorId: userId,
    detail: 'Runner enrollment approved',
    meta: { runnerId: result.runnerId },
  });
  return c.json({ ok: true, runnerId: result.runnerId });
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
