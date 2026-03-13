/**
 * Auth routes for the central server.
 * Proxies all /api/auth/* requests to Better Auth.
 */

import { Hono } from 'hono';

import { auth } from '../lib/auth.js';

export const authRoutes = new Hono();

authRoutes.all('/*', (c) => {
  return auth.handler(c.req.raw);
});
