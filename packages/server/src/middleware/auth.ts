/**
 * Auth middleware for the central server.
 * Supports two auth modes:
 * - Session cookie (for browser clients)
 * - Bearer token (for runners)
 */

import type { Context, Next } from 'hono';

import { auth } from '../lib/auth.js';
import type { ServerEnv } from '../lib/types.js';
import * as rm from '../services/runner-manager.js';

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/mode',
  '/api/bootstrap',
  '/api/setup/status',
]);

export async function authMiddleware(c: Context<ServerEnv>, next: Next) {
  const path = new URL(c.req.url).pathname;

  // Public endpoints
  if (PUBLIC_PATHS.has(path)) return next();

  // Better Auth handles its own routes
  if (path.startsWith('/api/auth/')) return next();

  // Runner auth via bearer token
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer runner_')) {
    const token = authHeader.slice(7);
    const runnerId = await rm.authenticateRunner(token);
    if (!runnerId) return c.json({ error: 'Invalid runner token' }, 401);

    c.set('runnerId', runnerId);
    c.set('isRunner', true);
    return next();
  }

  // Session auth for browser clients
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  c.set('userId', session.user.id);
  c.set('userRole', (session.user as any).role || 'user');
  c.set('isRunner', false);

  const activeOrgId = (session.session as any).activeOrganizationId ?? null;
  c.set('organizationId', activeOrgId);

  return next();
}

export async function requireAdmin(c: Context<ServerEnv>, next: Next) {
  const role = c.get('userRole');
  if (role !== 'admin') {
    return c.json({ error: 'Forbidden: admin required' }, 403);
  }
  return next();
}
