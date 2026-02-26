import { Hono } from 'hono';

import { getAuthToken } from '../services/auth-service.js';

export const authRoutes = new Hono();

/**
 * GET /api/auth/token
 * Returns the auth token for browser-based clients to bootstrap authentication.
 * Security: server is bound to 127.0.0.1 (localhost only) + CORS restricts
 * browser origins. Any local process could also read ~/.funny/auth-token directly.
 */
authRoutes.get('/token', (c) => {
  return c.json({ token: getAuthToken() });
});
