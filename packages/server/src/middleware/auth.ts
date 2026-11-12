/**
 * Auth middleware for the server.
 * Always uses Better Auth sessions for browser requests.
 * Runner auth via bearer token or X-Runner-Auth header.
 *
 * The auth instance is injected via `setAuthInstance()` at startup,
 * allowing standalone mode to use the runtime's auth (SQLite+PG)
 * and team mode to use the server's own auth (PG-only).
 */

import { timingSafeEqual } from 'crypto';

import type { Context, Next } from 'hono';

import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { normalizeUserRole } from '../lib/types.js';

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/bootstrap',
  // Device-link runner enrollment: a runner has no credentials yet, so the
  // start/poll endpoints must be reachable without auth. Approval + the
  // metadata lookup stay behind the session (see routes/runners.ts). These are
  // EXACT paths, not a prefix, so `/api/runners/enroll/approve` and
  // `/api/runners/enroll/:userCode` remain authenticated.
  '/api/runners/enroll/start',
  '/api/runners/enroll/poll',
]);

const PUBLIC_PREFIXES = ['/api/invite-links/verify/', '/api/invite-links/register'];

// Auth instance — set at startup via setAuthInstance()
let _auth: any = null;

/** Set the Better Auth instance used by middleware. Called once at startup. */
export function setAuthInstance(auth: any): void {
  _auth = auth;
}

/** Test-only: reset cached auth so mocked lib/auth.js is picked up again. */
export function resetAuthInstanceForTests(): void {
  _auth = null;
}

/** Sentinel returned by an auth step that authenticated the request (or let it through). */
const PROCEED = Symbol('auth-proceed');

/**
 * One authentication step. Returns `null` when the step does not apply (try
 * the next one), `PROCEED` to continue the middleware chain, or a Response to
 * short-circuit the request.
 */
type AuthStepResult = Response | typeof PROCEED | null;
type AuthStep = (c: Context<ServerEnv>, path: string) => AuthStepResult | Promise<AuthStepResult>;

const REGISTER_PATH = '/api/runners/register';

function isRegisterRequest(c: Context<ServerEnv>, path: string): boolean {
  return c.req.method === 'POST' && path === REGISTER_PATH;
}

/** Constant-time comparison of a presented header value against a configured secret. */
function secretMatches(presented: string | undefined, expected: string): boolean {
  return (
    !!presented &&
    presented.length === expected.length &&
    timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  );
}

function publicPathStep(_c: Context<ServerEnv>, path: string): AuthStepResult {
  // Public endpoints
  if (PUBLIC_PATHS.has(path)) return PROCEED;

  // Public invite-link paths
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return PROCEED;

  // Auth routes are handled by their own handlers
  if (path.startsWith('/api/auth/')) return PROCEED;

  // MCP OAuth callback
  if (path === '/api/mcp/oauth/callback') return PROCEED;

  return null;
}

// ── Sandbox runner registration via provisioning token ─────────
// A single-use, thread-bound token minted by the server when it provisions a
// sandbox (thread-sandboxes). The runner becomes that thread's sandbox runner.
async function provisionTokenStep(c: Context<ServerEnv>, path: string): Promise<AuthStepResult> {
  const provisionToken = c.req.header('X-Runner-Provision-Token');
  if (!provisionToken || !isRegisterRequest(c, path)) return null;
  const pt = await import('../services/runner-provision-tokens.js');
  const grant = await pt.consumeProvisionToken(provisionToken);
  if (grant.isErr()) {
    audit({
      action: 'auth.runner_rejected',
      actorId: null,
      detail: `Rejected X-Runner-Provision-Token on /api/runners/register (${grant.error.kind})`,
      meta: { path, method: c.req.method, reason: grant.error.kind },
    });
    return c.json({ error: 'Invalid runner provisioning token' }, 401);
  }
  c.set('userId', grant.value.userId);
  c.set('isRunner', false);
  c.set('provisionGrant', grant.value);
  return PROCEED;
}

// ── Runner registration via user invite token ──────────────────
// Allows a runner to self-register under a user's account without a session cookie.
async function inviteTokenStep(c: Context<ServerEnv>, path: string): Promise<AuthStepResult> {
  const inviteToken = c.req.header('X-Runner-Invite-Token');
  if (!inviteToken || !isRegisterRequest(c, path)) return null;
  const ps = await import('../services/profile-service.js');
  const userId = await ps.validateRunnerInviteToken(inviteToken);
  if (!userId) {
    audit({
      action: 'auth.runner_rejected',
      actorId: null,
      detail: 'Invalid X-Runner-Invite-Token on /api/runners/register',
      meta: { path, method: c.req.method },
    });
    return c.json({ error: 'Invalid runner invite token' }, 401);
  }
  c.set('userId', userId);
  c.set('isRunner', false);
  return PROCEED;
}

// ── Runner auth via bearer token ───────────────────────────────
async function runnerBearerStep(c: Context<ServerEnv>, path: string): Promise<AuthStepResult> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer runner_')) return null;
  const rm = await import('../services/runner-manager.js');
  const token = authHeader.slice(7);
  const runnerId = await rm.authenticateRunner(token);
  if (!runnerId) {
    audit({
      action: 'auth.runner_rejected',
      actorId: null,
      detail: 'Invalid runner bearer token',
      meta: { path, method: c.req.method },
    });
    return c.json({ error: 'Invalid runner token' }, 401);
  }

  c.set('runnerId', runnerId);
  c.set('isRunner', true);
  return PROCEED;
}

// ── Scheduler auth via shared secret + impersonated user ────
// Co-located scheduler binary calling server-native pipeline endpoints.
// Trust boundary: same-host process. The secret + X-Forwarded-User pair
// grants the scheduler the ability to act as `userId` for the duration
// of the request — per-tenant guards downstream still apply.
//
// System mode: when the path is under `/api/scheduler/system/*`, the
// X-Forwarded-User header is OPTIONAL — those endpoints are explicitly
// cross-tenant (the brain reads/writes runs and dependencies for ALL users).
function schedulerStep(c: Context<ServerEnv>, path: string): AuthStepResult {
  const ORCH_AUTH_SECRET = process.env.SCHEDULER_AUTH_SECRET;
  if (!ORCH_AUTH_SECRET) return null;
  if (!secretMatches(c.req.header('X-Scheduler-Auth'), ORCH_AUTH_SECRET)) return null;

  const isSystemPath = path.startsWith('/api/scheduler/system/');
  const forwardedUser = c.req.header('X-Forwarded-User');
  if (!forwardedUser && !isSystemPath) {
    audit({
      action: 'auth.scheduler_rejected',
      actorId: null,
      detail: 'X-Scheduler-Auth without X-Forwarded-User',
      meta: { path, method: c.req.method },
    });
    return c.json({ error: 'X-Forwarded-User required with scheduler auth' }, 401);
  }
  if (forwardedUser) c.set('userId', forwardedUser);
  c.set('isScheduler', true);
  c.set('isSchedulerSystem', isSystemPath && !forwardedUser);
  c.set('isRunner', false);
  return PROCEED;
}

// ── Runner auth via the ROOT shared secret ─────────────────────
// Only the deployment root `RUNNER_AUTH_SECRET` matches here — held by the
// server and operator-provisioned runners. A device-link / invite-token
// runner only knows its derived per-runner key (security H1), which never
// equals the root secret, so it cannot obtain `isRunner` this way; it
// authenticates with its bearer token (branch above) instead.
async function runnerSecretStep(c: Context<ServerEnv>, path: string): Promise<AuthStepResult> {
  const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET;
  if (!RUNNER_AUTH_SECRET) return null;
  if (!secretMatches(c.req.header('X-Runner-Auth'), RUNNER_AUTH_SECRET)) return null;

  c.set('isRunner', true);

  // Runner registration via shared secret is restricted to loopback, to
  // prevent remote attackers who obtain RUNNER_AUTH_SECRET from registering
  // a runner bound to the admin account. Remote runners MUST present a
  // `X-Runner-Invite-Token` (handled earlier in this middleware).
  if (isRegisterRequest(c, path)) {
    const rejected = await authorizeLoopbackRegistration(c, path);
    if (rejected) return rejected;
  }

  return PROCEED;
}

function isLoopbackAddress(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

/** Returns a rejection Response, or `null` when the loopback registration may proceed. */
async function authorizeLoopbackRegistration(
  c: Context<ServerEnv>,
  path: string,
): Promise<Response | null> {
  const addr = (c.env as any)?.IP?.address ?? '';
  if (!isLoopbackAddress(addr)) {
    log.warn('Runner registration via shared secret rejected (non-loopback)', {
      namespace: 'auth',
      addr,
    });
    audit({
      action: 'auth.runner_rejected',
      actorId: null,
      detail: 'Shared-secret runner registration from non-loopback address',
      meta: { path, method: c.req.method, addr },
    });
    return c.json(
      {
        error:
          'Runner registration requires X-Runner-Invite-Token. Generate one from Settings > Profile.',
      },
      401,
    );
  }

  // Security HI-13: loopback shared-secret registration previously
  // silently bound the runner to the first admin user. Any local
  // process able to read `RUNNER_AUTH_SECRET` (it sits in the
  // operator's `.env`) could register itself as admin's runner —
  // turning a low-privilege local user / sidecar / malicious npm
  // postinstall into an admin-proxying runner without any consent
  // signal.
  //
  // The new policy: operators who want the dev convenience must opt
  // in explicitly with `FUNNY_LOOPBACK_RUNNER_USERNAME=<name>`, which
  // selects which user the loopback runner binds to. Without that
  // env var the request is refused with guidance to use the
  // invite-token flow (Settings > Profile generates one).
  const optInUsername = process.env.FUNNY_LOOPBACK_RUNNER_USERNAME;
  if (!optInUsername) {
    log.warn('Loopback runner registration refused: no explicit opt-in', {
      namespace: 'auth',
    });
    audit({
      action: 'auth.runner_rejected',
      actorId: null,
      detail:
        'Loopback shared-secret runner registration requires FUNNY_LOOPBACK_RUNNER_USERNAME opt-in',
      meta: { path, method: c.req.method },
    });
    return c.json(
      {
        error:
          'Runner registration requires X-Runner-Invite-Token. ' +
          'Generate one from Settings > Profile, or set FUNNY_LOOPBACK_RUNNER_USERNAME ' +
          'to allow loopback registration under that account.',
      },
      401,
    );
  }
  return bindLoopbackRunnerUser(c, optInUsername);
}

/** Resolves the opt-in username to a user id and binds it; returns an error Response on failure. */
async function bindLoopbackRunnerUser(
  c: Context<ServerEnv>,
  optInUsername: string,
): Promise<Response | null> {
  try {
    // Security L-3: use the Drizzle query builder (with dialect-aware
    // schema) instead of raw SQL. The previous pg branch built a raw
    // `sql\`...\`` template; even though the value was parameterised,
    // the pattern is brittle (any caller who reuses it with a
    // non-literal column name or a future refactor that drops the
    // `${value}` binding turns it into an injection sink). One path
    // for both dialects also keeps the sqlite + pg behaviour aligned.
    const { db, dbDialect } = await import('../db/index.js');
    const { getSchema } = await import('@funny/shared/db/schema');
    const { eq } = await import('drizzle-orm');
    const s = getSchema(dbDialect) as { user: any };
    const rows = (await (db as any)
      .select({ id: s.user.id })
      .from(s.user)
      .where(eq(s.user.username, optInUsername))
      .limit(1)) as Array<{ id: string }>;
    const resolvedUserId = rows[0]?.id;

    if (!resolvedUserId) {
      log.error('FUNNY_LOOPBACK_RUNNER_USERNAME points at a non-existent user', {
        namespace: 'auth',
        username: optInUsername,
      });
      return c.json({ error: `FUNNY_LOOPBACK_RUNNER_USERNAME "${optInUsername}" not found` }, 500);
    }
    c.set('userId', resolvedUserId);
    audit({
      action: 'runner.register',
      actorId: resolvedUserId,
      detail: 'Loopback runner registration via FUNNY_LOOPBACK_RUNNER_USERNAME opt-in',
      meta: { username: optInUsername },
    });
    return null;
  } catch (err) {
    log.error('Failed to resolve loopback runner userId', {
      namespace: 'auth',
      error: (err as Error).message,
    });
    return c.json({ error: 'Failed to resolve userId for runner' }, 500);
  }
}

async function getAuth(): Promise<any> {
  if (!_auth) {
    // Fallback: import from server's auth module (team mode)
    const { auth } = await import('../lib/auth.js');
    _auth = auth;
  }
  return _auth;
}

// ── Better Auth session ────────────────────────────────────────
async function sessionStep(c: Context<ServerEnv>, path: string): Promise<AuthStepResult> {
  const auth = await getAuth();

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    log.warn('Session validation failed', {
      namespace: 'auth',
      path,
      hasCookie: !!c.req.header('cookie'),
    });
    audit({
      action: 'auth.session_rejected',
      actorId: null,
      detail: 'Session validation failed',
      meta: { path, method: c.req.method, hasCookie: !!c.req.header('cookie') },
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('userId', session.user.id);
  c.set('userRole', resolveSessionRole(session.user));
  c.set('isRunner', false);

  const activeOrgId = (session.session as any).activeOrganizationId ?? null;
  c.set('organizationId', activeOrgId);

  // Resolve org name for forwarding to runtime
  c.set('organizationName', await resolveOrgName(c, auth, session.user.id, activeOrgId));

  return PROCEED;
}

/**
 * Narrow the role to a validated enum. An unknown value (or an attacker
 * crafting an unexpected string into the session) is coerced to the
 * least-privileged role instead of being stored verbatim.
 */
function resolveSessionRole(user: any) {
  const rawRole: unknown =
    user && typeof user === 'object' ? (user as Record<string, unknown>).role : undefined;
  const role = normalizeUserRole(rawRole);
  if (rawRole !== undefined && typeof rawRole === 'string' && rawRole !== role) {
    log.warn('Unknown session role — coerced to user', {
      namespace: 'auth',
      rawRole,
      userId: user.id,
    });
    audit({
      action: 'auth.role_coerced',
      actorId: user.id,
      detail: 'Unknown session role coerced to least-privileged user',
      meta: { rawRole },
    });
  }
  return role;
}

/**
 * The org name is only forwarded to the runtime for display, yet looking it up
 * costs a Better Auth call (and its DB reads) on every authenticated request.
 * Cache it briefly per (user, org): keying by user keeps the membership check
 * that getFullOrganization performs per user. A rename shows within the TTL.
 */
const ORG_NAME_TTL_MS = 60_000;
const ORG_NAME_CACHE_MAX = 1_000;
const orgNameCache = new Map<string, { name: string | null; expiresAt: number }>();
const orgNameInFlight = new Map<string, Promise<string | null>>();

/** Test-only: drop cached organization names. */
export function resetOrgNameCacheForTests(): void {
  orgNameCache.clear();
  orgNameInFlight.clear();
}

async function fetchOrgName(
  c: Context<ServerEnv>,
  auth: any,
  activeOrgId: string,
): Promise<{ name: string | null; ok: boolean }> {
  try {
    const org = await auth.api.getFullOrganization({
      headers: c.req.raw.headers,
      query: { organizationId: activeOrgId },
    });
    return { name: org?.name ?? null, ok: true };
  } catch {
    // Org name unavailable; do not cache the failure.
    return { name: null, ok: false };
  }
}

async function resolveOrgName(
  c: Context<ServerEnv>,
  auth: any,
  userId: string,
  activeOrgId: string | null,
): Promise<string | null> {
  if (!activeOrgId) return null;
  const key = `${userId}\0${activeOrgId}`;
  const cached = orgNameCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  const pending = orgNameInFlight.get(key);
  if (pending) return pending;

  const lookup = fetchOrgName(c, auth, activeOrgId).then(({ name, ok }) => {
    if (ok) {
      if (orgNameCache.size >= ORG_NAME_CACHE_MAX) orgNameCache.clear();
      orgNameCache.set(key, { name, expiresAt: Date.now() + ORG_NAME_TTL_MS });
    }
    return name;
  });
  orgNameInFlight.set(key, lookup);
  try {
    return await lookup;
  } finally {
    orgNameInFlight.delete(key);
  }
}

/**
 * A personal API token works on the public REST API (`/api/v1`, mounted before
 * this middleware) and nowhere else: anywhere else it is refused, never
 * treated as a session (openspec public-rest-api-v1).
 */
function personalTokenOutsidePublicApiStep(c: Context<ServerEnv>, path: string): AuthStepResult {
  if (!/^Bearer\s+funny_pat_/i.test(c.req.header('authorization') ?? '')) return null;
  audit({
    action: 'pat.rejected',
    actorId: null,
    detail: 'Personal API token used outside /api/v1',
    meta: { reason: 'outside-public-api', path, method: c.req.method },
  });
  return c.json({ error: 'Personal API tokens only work on /api/v1' }, 401);
}

/**
 * Ordered authentication steps. The FIRST step that applies decides the
 * request; the session step always applies, so it must stay last.
 */
const AUTH_STEPS: readonly AuthStep[] = [
  publicPathStep,
  personalTokenOutsidePublicApiStep,
  provisionTokenStep,
  inviteTokenStep,
  runnerBearerStep,
  schedulerStep,
  runnerSecretStep,
  sessionStep,
];

export async function authMiddleware(c: Context<ServerEnv>, next: Next) {
  const path = new URL(c.req.url).pathname;
  for (const step of AUTH_STEPS) {
    const outcome = await step(c, path);
    if (outcome === null) continue;
    return outcome === PROCEED ? next() : outcome;
  }
  return next();
}

export async function requireAdmin(c: Context<ServerEnv>, next: Next) {
  const role = c.get('userRole');
  if (role !== 'admin') {
    audit({
      action: 'authz.cross_tenant_refused',
      actorId: c.get('userId') ?? null,
      detail: 'requireAdmin gate — caller is not an admin',
      meta: { path: new URL(c.req.url).pathname, method: c.req.method, role: role ?? null },
    });
    return c.json({ error: 'Forbidden: admin required' }, 403);
  }
  return next();
}

/**
 * Middleware factory that checks if the user has a specific permission
 * in their active organization.
 */
export function requirePermission(resource: string, action: string) {
  return async (c: Context<ServerEnv>, next: Next) => {
    const orgId = c.get('organizationId');
    if (!orgId) return next();

    if (!_auth) {
      const { auth } = await import('../lib/auth.js');
      _auth = auth;
    }

    try {
      const hasPermission = await _auth.api.hasPermission({
        headers: c.req.raw.headers,
        body: {
          permissions: {
            [resource]: [action],
          },
        },
      });

      if (!hasPermission) {
        return c.json({ error: `Forbidden: ${resource}:${action} permission required` }, 403);
      }
    } catch (err) {
      log.warn('Permission check failed — denying access', {
        namespace: 'auth',
        resource,
        action,
        error: String(err),
      });
      return c.json({ error: 'Forbidden: permission check failed' }, 403);
    }

    return next();
  };
}
