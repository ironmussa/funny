/**
 * User profile routes for the central server.
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import * as ps from '../services/profile-service.js';

export const profileRoutes = new Hono<ServerEnv>();

/** Generate a temporary AssemblyAI streaming token (API key stays server-side) */
profileRoutes.get('/transcribe-token', async (c) => {
  const userId = c.get('userId') as string;
  const apiKey = await ps.getProviderKey(userId, 'assemblyai');
  if (!apiKey) {
    return c.json({ error: 'AssemblyAI API key not configured' }, 400);
  }

  const res = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=600', {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const body = await res.text();
    return c.json({ error: `Token request failed: ${res.status} ${body}` }, 502);
  }

  const data = (await res.json()) as { token: string };
  return c.json({ token: data.token });
});

/** Get current user's profile */
profileRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const profile = await ps.getProfile(userId);

  return c.json(
    profile ?? {
      userId,
      gitName: null,
      gitEmail: null,
      providerKeys: {},
      hasGithubToken: false,
      hasAssemblyaiKey: false,
      hasMinimaxApiKey: false,
      setupCompleted: false,
      defaultEditor: null,
      useInternalEditor: null,
      terminalShell: null,
      toolPermissions: null,
      theme: null,
      runnerInviteToken: null,
    },
  );
});

/** Update current user's profile */
profileRoutes.put('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json<{
    gitName?: string;
    gitEmail?: string;
    providerKey?: { id: string; value: string | null };
    githubToken?: string | null;
    assemblyaiApiKey?: string | null;
    minimaxApiKey?: string | null;
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

/** GET /runner-invite-token — get (or auto-create) the user's runner invite token */
profileRoutes.get('/runner-invite-token', async (c) => {
  const userId = c.get('userId') as string;
  const token = await ps.getOrCreateRunnerInviteToken(userId);
  return c.json({ token });
});

/** POST /runner-invite-token/rotate — regenerate the runner invite token */
profileRoutes.post('/runner-invite-token/rotate', async (c) => {
  const userId = c.get('userId') as string;
  const token = await ps.rotateRunnerInviteToken(userId);
  return c.json({ token });
});
