import { Hono } from 'hono';

import { log } from '../lib/logger.js';
import { browserSessionManager } from '../services/browser-session-manager.js';
import type { HonoEnv } from '../types/hono-env.js';

const NS = 'browser-session';

export const browserSessionRoutes = new Hono<HonoEnv>();

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
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: unknown;
    url?: unknown;
  } | null;

  if (!body || typeof body.sessionId !== 'string' || typeof body.url !== 'string') {
    return c.json({ error: 'sessionId and url required' }, 400);
  }

  const { sessionId, url } = body;

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
