import type { Context, Next } from 'hono';
import { validateToken } from '../services/auth-service.js';

/** Paths that are exempt from bearer auth */
const EXEMPT_PATHS = new Set(['/api/auth/token', '/api/health', '/api/mcp/oauth/callback']);

/**
 * Bearer token authentication middleware.
 * Returns 401 if the Authorization header is missing or invalid.
 * Skips exempt paths (token endpoint, health check).
 */
export async function authMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  if (EXEMPT_PATHS.has(path)) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!validateToken(parts[1])) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
}
