import type { Context, Next } from 'hono';
import { getAuthMode } from '../lib/auth-mode.js';
import { validateToken } from '../services/auth-service.js';

/** Paths that skip authentication entirely */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/mode']);

/**
 * Dual-mode authentication middleware.
 * - local mode: validates bearer token from file (existing behavior)
 * - multi mode: validates Better Auth session cookie
 */
export async function authMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  // Public endpoints — always allowed
  if (PUBLIC_PATHS.has(path)) return next();

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
