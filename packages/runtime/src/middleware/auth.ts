/**
 * @domain subdomain: Authentication
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: AuthService, AuthMode
 */

import type { Context, Next } from 'hono';

import { getAuthMode } from '../lib/auth-mode.js';
import { validateToken } from '../services/auth-service.js';
import { isTeamModeActive } from '../services/team-client.js';

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET || 'funny-server-proxy';

/** Paths that skip authentication entirely */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/mode', '/api/bootstrap']);

/**
 * Dual-mode authentication middleware.
 * - local mode: validates bearer token from file (existing behavior)
 * - multi mode: validates Better Auth session cookie + extracts org context
 * - team mode (proxied): trusts X-Forwarded-User from the central server
 */
export async function authMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  // Public endpoints — always allowed
  if (PUBLIC_PATHS.has(path)) return next();

  // Proxied requests from the central server carry X-Runner-Auth + X-Forwarded-User.
  // Check this regardless of isTeamModeActive() — the server may be proxying via
  // DEFAULT_RUNNER_URL before the runtime has formally registered.
  const runnerAuth = c.req.header('X-Runner-Auth');
  if (runnerAuth === RUNNER_AUTH_SECRET) {
    const forwardedUser = c.req.header('X-Forwarded-User');
    if (!forwardedUser) return c.json({ error: 'Unauthorized: missing X-Forwarded-User' }, 401);

    c.set('userId', forwardedUser);
    c.set('userRole', 'user');
    c.set('organizationId', c.req.header('X-Forwarded-Org') || null);
    return next();
  }

  if (getAuthMode() === 'local') {
    // Local mode: existing bearer token auth
    if (path.startsWith('/api/auth/')) return next();
    if (path === '/api/mcp/oauth/callback') return next();

    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.json({ error: 'Unauthorized' }, 401);

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return c.json({ error: 'Unauthorized' }, 401);
    if (!validateToken(parts[1])) return c.json({ error: 'Unauthorized' }, 401);

    c.set('userId', '__local__');
    c.set('userRole', 'admin');
    // No org context in local mode
    c.set('organizationId', null);
    return next();
  }

  // Multi mode: Better Auth session validation
  if (path.startsWith('/api/auth/')) return next(); // Better Auth handles its own routes
  if (path === '/api/mcp/oauth/callback') return next();

  const { auth } = await import('../lib/auth.js');
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  c.set('userId', session.user.id);
  c.set('userRole', (session.user as any).role || 'user');

  // Extract active organization from session (set by Better Auth org plugin)
  const activeOrgId = (session.session as any).activeOrganizationId ?? null;
  c.set('organizationId', activeOrgId);

  return next();
}

/**
 * Middleware that requires admin role.
 * In local mode, everyone is effectively admin.
 */
export async function requireAdmin(c: Context, next: Next) {
  if (getAuthMode() === 'local') return next();

  const role = c.get('userRole');
  if (role !== 'admin') {
    return c.json({ error: 'Forbidden: admin required' }, 403);
  }
  return next();
}

/**
 * Middleware factory that checks if the user has a specific permission
 * in their active organization. Skips in local mode.
 *
 * Usage: `app.post('/api/projects', requirePermission('project', 'create'), handler)`
 */
export function requirePermission(resource: string, action: string) {
  return async (c: Context, next: Next) => {
    if (getAuthMode() === 'local') return next();

    const orgId = c.get('organizationId');
    if (!orgId) {
      // No active org — allow if it's a user-scoped action
      return next();
    }

    const { auth } = await import('../lib/auth.js');
    try {
      const hasPermission = await auth.api.hasPermission({
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
    } catch {
      // If permission check fails (e.g. org plugin not fully initialized), allow through
    }

    return next();
  };
}
