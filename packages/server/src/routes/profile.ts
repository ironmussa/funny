/**
 * User profile routes for the central server.
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import * as ps from '../services/profile-service.js';

export const profileRoutes = new Hono<ServerEnv>();

/** Get current user's profile */
profileRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const profile = await ps.getProfile(userId);
  return c.json({
    ...(profile ?? { userId, gitName: null, gitEmail: null, hasGithubToken: false }),
    setupCompleted: true, // Central server is always "set up"
  });
});

/** Update current user's profile */
profileRoutes.put('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json<{ gitName?: string; gitEmail?: string; githubToken?: string }>();

  const profile = await ps.upsertProfile(userId, body);
  return c.json(profile);
});
