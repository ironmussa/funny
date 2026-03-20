/**
 * Auth middleware for the server.
 * Always uses Better Auth sessions for browser requests.
 * Runner auth via bearer token or X-Runner-Auth header.
 *
 * The auth instance is injected via `setAuthInstance()` at startup,
 * allowing standalone mode to use the runtime's auth (SQLite+PG)
 * and team mode to use the server's own auth (PG-only).
 */

import type { Context, Next } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';

const PUBLIC_PATHS = new Set(['/api/health', '/api/bootstrap', '/api/setup/status']);

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
    if (!userId) return c.json({ error: 'Invalid runner invite token' }, 401);
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
    if (!runnerId) return c.json({ error: 'Invalid runner token' }, 401);

    c.set('runnerId', runnerId);
    c.set('isRunner', true);
    return next();
  }

  // ── Runner auth via shared secret ──────────────────────────────
  const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET;
  if (RUNNER_AUTH_SECRET) {
    const runnerSecret = c.req.header('X-Runner-Auth');
    if (runnerSecret === RUNNER_AUTH_SECRET) {
      c.set('isRunner', true);

      // For runner registration, associate the runner with the admin user
      // so that project resolution can match runners by userId.
      if (c.req.method === 'POST' && path === '/api/runners/register') {
        try {
          // The "user" table is managed by Better Auth, not in our Drizzle schema.
          // Use the raw connection to query it (works with both SQLite and PostgreSQL).
          const { getConnection } = await import('../db/index.js');
          const conn = getConnection();
          let adminId: string | undefined;

          if (conn?.sqlite) {
            const row = conn.sqlite
              .query('SELECT id FROM "user" WHERE role = ? LIMIT 1')
              .get('admin') as { id: string } | null;
            adminId = row?.id;
          }

          if (adminId) {
            c.set('userId', adminId);
          } else {
            log.error('No admin user found — runner cannot register without userId', {
              namespace: 'auth',
            });
            return c.json({ error: 'No admin user found for runner association' }, 500);
          }
        } catch (err) {
          log.error('Failed to resolve admin userId for runner registration', {
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
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('userId', session.user.id);
  c.set('userRole', (session.user as any).role || 'user');
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
