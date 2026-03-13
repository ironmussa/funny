/**
 * User profile routes for the central server.
 */

import { Hono } from 'hono';

import * as ps from '../services/profile-service.js';

export const profileRoutes = new Hono();

/** Get current user's profile */
profileRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const profile = await ps.getProfile(userId);
  return c.json(profile ?? { userId, gitName: null, gitEmail: null, hasGithubToken: false });
});

/** Update current user's profile */
profileRoutes.put('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json<{ gitName?: string; gitEmail?: string; githubToken?: string }>();

  const profile = await ps.upsertProfile(userId, body);
  return c.json(profile);
});
