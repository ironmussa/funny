import { Hono } from 'hono';

import * as ps from '../services/profile-service.js';
import type { HonoEnv } from '../types/hono-env.js';

export const profileRoutes = new Hono<HonoEnv>();

// GET /api/profile — get current user's git profile
profileRoutes.get('/', (c) => {
  const userId = c.get('userId') as string;
  const profile = ps.getProfile(userId);
  return c.json(
    profile ?? {
      gitName: null,
      gitEmail: null,
      hasGithubToken: false,
    },
  );
});

// PUT /api/profile — update current user's git profile
profileRoutes.put('/', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json().catch(() => ({}));

  const data: { gitName?: string; gitEmail?: string; githubToken?: string | null } = {};
  if (typeof raw.gitName === 'string') data.gitName = raw.gitName;
  if (typeof raw.gitEmail === 'string') data.gitEmail = raw.gitEmail;
  if (raw.githubToken === null || typeof raw.githubToken === 'string')
    data.githubToken = raw.githubToken;

  const profile = ps.updateProfile(userId, data);
  return c.json(profile);
});
