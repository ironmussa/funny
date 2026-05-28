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

const PUBLIC_PATHS = new Set(['/api/health', '/api/bootstrap']);

const PUBLIC_PREFIXES = ['/api/invite-links/verify/', '/api/invite-links/register'];

// Auth instance — set at startup via setAuthInstance()
let _auth: any = null;

/** Set the Better Auth instance used by middleware. Called once at startup. */
export function setAuthInstance(auth: any): void {
  _auth = auth;
}

export async function authMiddleware(c: Context<ServerEnv>, next: Next) {
  const path = new URL(c.req.url).pathname;

  // Public endpoints
  if (PUBLIC_PATHS.has(path)) return next();

  // Public invite-link paths
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return next();

  // Auth routes are handled by their own handlers
  if (path.startsWith('/api/auth/')) return next();

  // MCP OAuth callback
  if (path === '/api/mcp/oauth/callback') return next();

  // ── Runner registration via user invite token ──────────────────
  // Allows a runner to self-register under a user's account without a session cookie.
  const inviteToken = c.req.header('X-Runner-Invite-Token');
  if (inviteToken && c.req.method === 'POST' && path === '/api/runners/register') {
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
    return next();
  }

  // ── Runner auth via bearer token ───────────────────────────────
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer runner_')) {
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
    return next();
  }

  // ── Orchestrator auth via shared secret + impersonated user ────
  // Co-located orchestrator binary calling server-native pipeline endpoints.
  // Trust boundary: same-host process. The secret + X-Forwarded-User pair
  // grants the orchestrator the ability to act as `userId` for the duration
  // of the request — per-tenant guards downstream still apply.
  //
  // System mode: when the path is under `/api/orchestrator/system/*`, the
  // X-Forwarded-User header is OPTIONAL — those endpoints are explicitly
  // cross-tenant (the brain reads/writes runs and dependencies for ALL users).
  const ORCH_AUTH_SECRET = process.env.ORCHESTRATOR_AUTH_SECRET;
  if (ORCH_AUTH_SECRET) {
    const orchSecret = c.req.header('X-Orchestrator-Auth');
    if (
      orchSecret &&
      orchSecret.length === ORCH_AUTH_SECRET.length &&
      timingSafeEqual(Buffer.from(orchSecret), Buffer.from(ORCH_AUTH_SECRET))
    ) {
      const isSystemPath = path.startsWith('/api/orchestrator/system/');
      const forwardedUser = c.req.header('X-Forwarded-User');
      if (!forwardedUser && !isSystemPath) {
        audit({
          action: 'auth.orchestrator_rejected',
          actorId: null,
          detail: 'X-Orchestrator-Auth without X-Forwarded-User',
          meta: { path, method: c.req.method },
        });
        return c.json({ error: 'X-Forwarded-User required with orchestrator auth' }, 401);
      }
      if (forwardedUser) c.set('userId', forwardedUser);
      c.set('isOrchestrator', true);
      c.set('isOrchestratorSystem', isSystemPath && !forwardedUser);
      c.set('isRunner', false);
      return next();
    }
  }

  // ── Runner auth via shared secret ──────────────────────────────
  const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET;
  if (RUNNER_AUTH_SECRET) {
    const runnerSecret = c.req.header('X-Runner-Auth');
    if (
      runnerSecret &&
      runnerSecret.length === RUNNER_AUTH_SECRET.length &&
      timingSafeEqual(Buffer.from(runnerSecret), Buffer.from(RUNNER_AUTH_SECRET))
    ) {
      c.set('isRunner', true);

      // Runner registration via shared secret is restricted to loopback, to
      // prevent remote attackers who obtain RUNNER_AUTH_SECRET from registering
      // a runner bound to the admin account. Remote runners MUST present a
      // `X-Runner-Invite-Token` (handled earlier in this middleware).
      if (c.req.method === 'POST' && path === '/api/runners/register') {
        const addr = (c.env as any)?.IP?.address ?? '';
        const isLoopback =
          addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
        if (!isLoopback) {
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

          if (resolvedUserId) {
            c.set('userId', resolvedUserId);
            audit({
              action: 'runner.register',
              actorId: resolvedUserId,
              detail: 'Loopback runner registration via FUNNY_LOOPBACK_RUNNER_USERNAME opt-in',
              meta: { username: optInUsername },
            });
          } else {
            log.error('FUNNY_LOOPBACK_RUNNER_USERNAME points at a non-existent user', {
              namespace: 'auth',
              username: optInUsername,
            });
            return c.json(
              { error: `FUNNY_LOOPBACK_RUNNER_USERNAME "${optInUsername}" not found` },
              500,
            );
          }
        } catch (err) {
          log.error('Failed to resolve loopback runner userId', {
            namespace: 'auth',
            error: (err as Error).message,
          });
          return c.json({ error: 'Failed to resolve userId for runner' }, 500);
        }
      }

      return next();
    }
  }

  // ── Better Auth session ────────────────────────────────────────
  if (!_auth) {
    // Fallback: import from server's auth module (team mode)
    const { auth } = await import('../lib/auth.js');
    _auth = auth;
  }

  const session = await _auth.api.getSession({ headers: c.req.raw.headers });
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
  // Narrow the role to a validated enum. An unknown value (or an attacker
  // crafting an unexpected string into the session) is coerced to the
  // least-privileged role instead of being stored verbatim.
  const rawRole: unknown =
    session.user && typeof session.user === 'object'
      ? (session.user as Record<string, unknown>).role
      : undefined;
  const role = normalizeUserRole(rawRole);
  if (rawRole !== undefined && typeof rawRole === 'string' && rawRole !== role) {
    log.warn('Unknown session role — coerced to user', {
      namespace: 'auth',
      rawRole,
      userId: session.user.id,
    });
    audit({
      action: 'auth.role_coerced',
      actorId: session.user.id,
      detail: 'Unknown session role coerced to least-privileged user',
      meta: { rawRole },
    });
  }
  c.set('userRole', role);
  c.set('isRunner', false);

  const activeOrgId = (session.session as any).activeOrganizationId ?? null;
  c.set('organizationId', activeOrgId);

  // Resolve org name for forwarding to runtime
  let orgName: string | null = null;
  if (activeOrgId) {
    try {
      const org = await _auth.api.getFullOrganization({
        headers: c.req.raw.headers,
        query: { organizationId: activeOrgId },
      });
      orgName = org?.name ?? null;
    } catch {
      // Org name unavailable
    }
  }
  c.set('organizationName', orgName);

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
          permission: {
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
