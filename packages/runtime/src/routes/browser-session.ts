import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { browserSessionManager } from '../services/browser-session-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { parseJsonBody } from '../validation/request.js';

const NS = 'browser-session';

export const browserSessionRoutes = new Hono<HonoEnv>();

const openBrowserSessionSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  url: z.string().min(1, 'url is required'),
});

/**
 * POST /api/browser-session
 * Body: { sessionId: string, url: string }
 *
 * Spawns (or reuses) a Chromium subprocess for this user and navigates to the
 * URL. The frame stream + readiness signal arrive separately via WebSocket
 * (`browser-session:ready`, `browser-session:frame`). This endpoint returns
 * `202 Accepted` immediately so the client UI can render a spinner.
 */
browserSessionRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const parsed = await parseJsonBody(c, openBrowserSessionSchema);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { sessionId, url } = parsed.value;

  // Fire-and-forget: the spawn takes ~2s, return immediately and let the
  // client wait for the `browser-session:ready` WS event.
  browserSessionManager.open(userId, sessionId, url).catch((err) => {
    log.error('browser-session open failed', {
      namespace: NS,
      sessionId,
      url,
      error: String(err),
    });
  });

  return c.json({ status: 'spawning', sessionId }, 202);
});

/**
 * DELETE /api/browser-session/:sessionId
 * Closes the session: disconnects CDP, kills Chromium, frees the port.
 */
browserSessionRoutes.delete('/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  await browserSessionManager.close(sessionId, 'user');
  return c.json({ status: 'closed' });
});

/**
 * GET /api/browser-session
 * Returns per-runner stats — used for diagnostics, not by the panel UI.
 */
browserSessionRoutes.get('/', (c) => {
  return c.json(browserSessionManager.getStats());
});
