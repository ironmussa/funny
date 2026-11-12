/**
 * Runner routes for the central server: what a runner calls with its own
 * credential (register, enrollment start / poll, heartbeat, tasks, its own
 * record and project assignments).
 *
 * The user-facing operations (list, remove, project assignment, enrollment
 * lookup and approval) are served by the `runners` tRPC router. A user calling
 * their old REST paths is refused here (`refuseUser`: 401 without a session,
 * 404 otherwise), never left to fall through to the runner proxy.
 */

import { assignRunnerProjectBody } from '@funny/shared/contracts/runners';
import type {
  RunnerRegisterRequest,
  RunnerHeartbeatRequest,
  RunnerTaskResultRequest,
  EnrollStartRequest,
  EnrollPollRequest,
  EnrollPollResponse,
} from '@funny/shared/runner-protocol';
import { Hono, type Context } from 'hono';

import { audit } from '../lib/audit.js';
import { clientIp } from '../lib/client-ip.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import * as enroll from '../services/runner-enrollment-service.js';
import * as rm from '../services/runner-manager.js';
import {
  recordProvisionedRunner,
  type ProvisionGrant,
} from '../services/runner-provision-tokens.js';
import { parseJsonBody } from '../validation/request.js';

export const runnerRoutes = new Hono<ServerEnv>();

// ── Registration ────────────────────────────────────────

function hasRequiredRegisterFields(body: RunnerRegisterRequest): boolean {
  return !!body.name && !!body.hostname && !!body.os;
}

/** Register a sandbox runner bound to the thread its provisioning grant names. */
async function registerSandboxRunnerFromGrant(
  c: Context<ServerEnv>,
  body: RunnerRegisterRequest,
  userId: string,
  grant: ProvisionGrant,
) {
  const result = await rm.registerSandboxRunner(body, userId, grant.threadId);
  await recordProvisionedRunner(grant.tokenId, result.runnerId);
  audit({
    action: 'runner.register_sandbox',
    actorId: userId,
    detail: `Sandbox runner "${body.name}" registered for thread ${grant.threadId}`,
    meta: { runnerId: result.runnerId, threadId: grant.threadId, hostname: body.hostname },
  });
  return c.json(result, 201);
}

async function registerUserRunner(
  c: Context<ServerEnv>,
  body: RunnerRegisterRequest,
  userId: string,
) {
  const result = await rm.registerRunner(body, userId);
  audit({
    action: 'runner.register',
    actorId: userId,
    detail: `Runner "${body.name}" registered`,
    meta: { runnerId: result.runnerId, hostname: body.hostname, os: body.os },
  });
  return c.json(result, 201);
}

function errorMessage(err: any): string {
  return err?.message || String(err);
}

function errorCause(err: any): string {
  return String(err?.cause?.message || err?.cause || '');
}

function errorCode(err: any): string {
  return String(err?.code || err?.cause?.code || '');
}

function errorStack(err: any): string {
  return err?.stack?.split('\n').slice(0, 5).join(' | ') || '';
}

// Kept on REST: called by the runner at startup (packages/runtime).
runnerRoutes.post('/register', async (c) => {
  try {
    const body = await c.req.json<RunnerRegisterRequest>();

    if (!hasRequiredRegisterFields(body)) {
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
    const grant = c.get('provisionGrant');
    if (grant) return await registerSandboxRunnerFromGrant(c, body, userId, grant);
    return await registerUserRunner(c, body, userId);
  } catch (err: any) {
    // Full diagnostics go to the structured logger only — never to the client.
    // Returning err.message risks leaking DB paths, internal codes, or stack
    // fragments embedded in driver errors.
    log.error('Runner registration failed', {
      namespace: 'runner',
      error: errorMessage(err),
      cause: errorCause(err),
      code: errorCode(err),
      stack: errorStack(err),
    });
    return c.json({ error: 'Registration failed' }, 500);
  }
});

// ── Device-Link Enrollment ──────────────────────────────
// start + poll are PUBLIC (a runner has no credentials yet); they are added to
// the public-path allowlist in middleware/auth.ts. The user's metadata lookup
// and approval are on tRPC (`runners.enrollment` / `runners.approveEnrollment`).

// Kept on REST: called by a runner without credentials (packages/runtime device-link enrollment).
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
    ip: clientIp(c) ?? '',
  });
  return c.json(result, 201);
});

// Kept on REST: called by a runner without credentials (packages/runtime device-link enrollment).
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
    forwardingKey: result.forwardingKey,
    ownerUserId: result.ownerUserId,
  } satisfies EnrollPollResponse);
});

// Removed (now `runners.enrollment` / `runners.approveEnrollment` on tRPC): refused.
runnerRoutes.get('/enroll/:userCode', (c) => refuseUser(c));
runnerRoutes.post('/enroll/approve', (c) => refuseUser(c));

// ── Heartbeat ───────────────────────────────────────────

// Kept on REST: called by the runner with its own credential (packages/runtime).
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

  // Tell the runner whether its gRPC session is connected from the server's perspective.
  // This lets the runner detect stale connections (e.g. after server restart).
  return c.json({
    ok: true,
    grpcConnected: (await c.env?.runnerPresence?.isAvailable(runnerId)) ?? false,
  });
});

// ── Task Polling ────────────────────────────────────────

// Kept on REST: called by the runner with its own credential (packages/runtime).
runnerRoutes.get('/tasks', async (c) => {
  const runnerId = c.get('runnerId') as string | undefined;
  if (!runnerId) return c.json({ error: 'Unauthorized: runner token required' }, 401);

  const tasks = await rm.getPendingTasks(runnerId);
  return c.json({ tasks });
});

// ── Task Result ─────────────────────────────────────────

// Kept on REST: called by the runner with its own credential (packages/runtime).
runnerRoutes.post('/tasks/result', async (c) => {
  // Bound to the calling runner: a runner can only complete its OWN tasks.
  const self = runnerSelfId(c);
  if (!self) return c.json({ error: 'Unauthorized: runner token required' }, 401);
  const updated = await rm.completeTask(self, await c.req.json<RunnerTaskResultRequest>());
  if (!updated) return c.json({ error: 'Task not found' }, 404);
  return c.json({ ok: true });
});

// ── Runner Listing ──────────────────────────────────────

// Kept on REST for a runner credential, which sees only ITSELF: it must never
// enumerate other tenants' runners (audit H2). Users list over `runners.list`.
runnerRoutes.get('/', async (c) => {
  if (!c.get('isRunner')) return refuseUser(c);
  const ownRunnerId = runnerSelfId(c);
  const own = ownRunnerId ? await rm.getRunner(ownRunnerId) : null;
  return c.json({ runners: own ? [own] : [] });
});

// Kept on REST: a runner reads its own record (the owner or an admin may read it too).
runnerRoutes.get('/:runnerId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const userId = c.get('userId') as string | undefined;
  const isRunner = c.get('isRunner') as boolean | undefined;
  const userRole = c.get('userRole') as string | undefined;

  const runner = await rm.getRunner(runnerId);
  if (!runner) return c.json({ error: 'Runner not found' }, 404);

  // Tenant isolation: only the owner, an admin, or the runner ITSELF may view
  // a runner record. Otherwise return 404 rather than 403 so we don't
  // disclose the runner's existence.
  if (isRunner) {
    if (!isRunnerSelf(c, runnerId)) return c.json({ error: 'Runner not found' }, 404);
    return c.json(runner);
  }
  const isAdmin = userRole === 'admin';
  const ownerId = await rm.getRunnerUserId(runnerId);
  const isOwner = !!userId && ownerId === userId;
  if (!isAdmin && !isOwner) {
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

// Removed (now `runners.remove` on tRPC): refused.
runnerRoutes.delete('/:runnerId', (c) => refuseUser(c));

// ── Project Assignment ──────────────────────────────────

/**
 * The runner identity of a runner-authenticated caller: the `runnerId` bound
 * by its bearer token. A caller holding only the shared `X-Runner-Auth`
 * secret has NO runner identity and therefore gets no cross-runner access.
 */
function runnerSelfId(c: Context<ServerEnv>): string | null {
  const id = c.get('runnerId') as string | undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** True when a runner-authenticated caller is acting on its OWN runner record. */
function isRunnerSelf(c: Context<ServerEnv>, runnerId: string): boolean {
  const self = runnerSelfId(c);
  const ok = self !== null && self === runnerId;
  if (!ok) {
    audit({
      action: 'authz.cross_tenant_refused',
      actorId: null,
      detail: 'Runner access refused — runner credential acting on another runner',
      meta: { runnerId, callerRunnerId: self, path: c.req.path, method: c.req.method },
    });
  }
  return ok;
}

/**
 * A user calling a removed REST route (now on the `runners` tRPC router): 401
 * without a session, 404 otherwise. Answered here so the request never falls
 * through to the runner proxy.
 */
function refuseUser(c: Context<ServerEnv>): Response {
  if (!c.get('userId')) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ error: 'Not found' }, 404);
}

/**
 * Runs an operation on a runner's own project assignments: only a runner
 * credential on its OWN record (404 otherwise, audited). A user is refused
 * (`refuseUser`); users manage assignments over the `runners` tRPC router.
 */
async function onOwnRunner(
  c: Context<ServerEnv>,
  runnerId: string,
  asRunner: () => Promise<Response>,
): Promise<Response> {
  if (!c.get('isRunner')) return refuseUser(c);
  if (!(await rm.getRunner(runnerId)) || !isRunnerSelf(c, runnerId)) {
    return c.json({ error: 'Runner not found' }, 404);
  }
  return asRunner();
}

// Kept on REST for a runner credential on its own record: the runner writes and
// reads its project LOCATION records (packages/runtime). Users go through tRPC.
runnerRoutes.post('/:runnerId/projects', async (c) => {
  const runnerId = c.req.param('runnerId');
  return onOwnRunner(c, runnerId, async () => {
    const parsed = await parseJsonBody(c, assignRunnerProjectBody);
    if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
    return c.json(await rm.assignProject(runnerId, parsed.value), 201);
  });
});

runnerRoutes.get('/:runnerId/projects', async (c) => {
  const runnerId = c.req.param('runnerId');
  return onOwnRunner(c, runnerId, async () =>
    c.json({ assignments: await rm.listAssignments(runnerId) }),
  );
});

runnerRoutes.delete('/:runnerId/projects/:projectId', async (c) => {
  const runnerId = c.req.param('runnerId');
  const projectId = c.req.param('projectId');
  return onOwnRunner(c, runnerId, async () => {
    await rm.unassignProject(runnerId, { projectId });
    return c.json({ ok: true });
  });
});
