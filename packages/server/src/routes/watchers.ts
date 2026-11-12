/**
 * Agent-watcher REST routes for the central server.
 *
 * Watchers (deferred-wake "snooze") are persisted in the server DB, so the
 * panel reads/cancels them directly here — no runner round-trip, robust to
 * the runner being offline. Create/fire/reschedule/expire originate on the
 * runner and reach the client as `watcher:*` WS events via the wsBroker relay.
 * The logic lives in `trpc/ports/background.ts`, shared with the `watchers`
 * tRPC procedures (openspec adopt-trpc-browser-api).
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { watchersPort as port } from '../trpc/ports/background.js';
import { answerJson } from '../trpc/reply.js';

export const watcherRoutes = new Hono<ServerEnv>();

// GET /api/watchers — the current user's watchers (cross-thread, newest first)
watcherRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  return answerJson(c, port.list(userId));
});

// POST /api/watchers/:id/cancel — stop a watcher (ownership-checked)
watcherRoutes.post('/:id/cancel', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  return answerJson(c, port.cancel(userId, c.req.param('id')));
});
