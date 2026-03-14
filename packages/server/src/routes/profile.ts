/**
 * User profile routes for the central server.
 *
 * Most profile data (git identity, GitHub token) is managed locally.
 * Endpoints that require runtime-side logic (e.g. transcribe-token)
 * are proxied to the runner.
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import * as ps from '../services/profile-service.js';

export const profileRoutes = new Hono<ServerEnv>();

/** Proxy transcribe-token to the runtime (AssemblyAI logic lives there) */
profileRoutes.get('/transcribe-token', proxyToRunner);

/** Get current user's profile */
profileRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const profile = await ps.getProfile(userId);

  return c.json(
    profile ?? {
      userId,
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

/** Update current user's profile */
profileRoutes.put('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json<{
    gitName?: string;
    gitEmail?: string;
    githubToken?: string;
    assemblyaiApiKey?: string | null;
    setupCompleted?: boolean;
    defaultEditor?: string;
    useInternalEditor?: boolean;
    terminalShell?: string;
    toolPermissions?: Record<string, any>;
    theme?: string;
  }>();

  const profile = await ps.upsertProfile(userId, body);

  return c.json(profile);
});

/** GET /setup-completed */
profileRoutes.get('/setup-completed', async (c) => {
  const userId = c.get('userId') as string;
  return c.json({ setupCompleted: await ps.isSetupCompleted(userId) });
});
