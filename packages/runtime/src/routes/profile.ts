/**
 * @domain subdomain: User Profile
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ProfileService
 */

import { Hono } from 'hono';

import * as ps from '../services/profile-service.js';
import { createTranscribeToken } from '../services/transcribe-stream.js';
import type { HonoEnv } from '../types/hono-env.js';

export const profileRoutes = new Hono<HonoEnv>();

// GET /api/profile — get current user's git profile
profileRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const profile = await ps.getProfile(userId);
  return c.json(
    profile ?? {
      gitName: null,
      gitEmail: null,
      hasGithubToken: false,
      hasAssemblyaiKey: false,
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
  if (raw.assemblyaiApiKey === null || typeof raw.assemblyaiApiKey === 'string')
    data.assemblyaiApiKey = raw.assemblyaiApiKey;
  if (typeof raw.setupCompleted === 'boolean') data.setupCompleted = raw.setupCompleted;
  if (typeof raw.defaultEditor === 'string') data.defaultEditor = raw.defaultEditor;
  if (typeof raw.useInternalEditor === 'boolean') data.useInternalEditor = raw.useInternalEditor;
  if (typeof raw.terminalShell === 'string') data.terminalShell = raw.terminalShell;
  if (raw.toolPermissions && typeof raw.toolPermissions === 'object')
    data.toolPermissions = raw.toolPermissions;
  if (typeof raw.theme === 'string') data.theme = raw.theme;

  const profile = await ps.updateProfile(userId, data);
  return c.json(profile);
});

// GET /api/profile/transcribe-token — get a temporary AssemblyAI token for direct browser connection
profileRoutes.get('/transcribe-token', async (c) => {
  const userId = c.get('userId') as string;
  const result = await createTranscribeToken(userId);
  if (result.isErr()) {
    return c.json({ error: result.error }, 400);
  }
  return c.json({ token: result.value });
});

// GET /api/profile/setup-completed — lightweight check for setup status
profileRoutes.get('/setup-completed', async (c) => {
  const userId = c.get('userId') as string;
  return c.json({ setupCompleted: await ps.isSetupCompleted(userId) });
});
