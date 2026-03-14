/**
 * @domain subdomain: User Profile
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ProfileService
 */

import { Hono } from 'hono';

import { createTranscribeToken } from '../services/transcribe-stream.js';
import type { HonoEnv } from '../types/hono-env.js';

export const profileRoutes = new Hono<HonoEnv>();

// GET /api/profile/transcribe-token — get a temporary AssemblyAI token for direct browser connection
profileRoutes.get('/transcribe-token', async (c) => {
  const userId = c.get('userId') as string;
  const result = await createTranscribeToken(userId);
  if (result.isErr()) {
    return c.json({ error: result.error }, 400);
  }
  return c.json({ token: result.value });
});
