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
      setupCompleted: false,
      defaultEditor: null,
      useInternalEditor: null,
      terminalShell: null,
      toolPermissions: null,
      theme: null,
    },
  );
});

// PUT /api/profile — update current user's git profile
profileRoutes.put('/', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json().catch(() => ({}));

  const data: Record<string, any> = {};
  if (typeof raw.gitName === 'string') data.gitName = raw.gitName;
  if (typeof raw.gitEmail === 'string') data.gitEmail = raw.gitEmail;
  if (raw.githubToken === null || typeof raw.githubToken === 'string')
    data.githubToken = raw.githubToken;
  if (typeof raw.setupCompleted === 'boolean') data.setupCompleted = raw.setupCompleted;
  if (typeof raw.defaultEditor === 'string') data.defaultEditor = raw.defaultEditor;
  if (typeof raw.useInternalEditor === 'boolean') data.useInternalEditor = raw.useInternalEditor;
  if (typeof raw.terminalShell === 'string') data.terminalShell = raw.terminalShell;
  if (raw.toolPermissions && typeof raw.toolPermissions === 'object')
    data.toolPermissions = raw.toolPermissions;
  if (typeof raw.theme === 'string') data.theme = raw.theme;

  const profile = ps.updateProfile(userId, data);
  return c.json(profile);
});

// GET /api/profile/setup-completed — lightweight check for setup status
profileRoutes.get('/setup-completed', (c) => {
  const userId = c.get('userId') as string;
  return c.json({ setupCompleted: ps.isSetupCompleted(userId) });
});
