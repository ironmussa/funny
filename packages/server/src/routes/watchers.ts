/**
 * Agent-watcher routes for the central server.
 *
 * Watchers (deferred-wake "snooze") are persisted in the server DB, so the
 * panel reads/cancels them directly here — no runner round-trip, robust to
 * the runner being offline. Create/fire/reschedule/expire originate on the
 * runner and reach the client as `watcher:*` WS events via the wsBroker relay.
 *
 * Cancel just flips the DB status to `cancelled`; the runner's scanner only
 * fires `status = pending` rows, so it stops on its own. The acting client
 * updates its store optimistically.
 */

import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/index.js';
import { watchers } from '../db/schema.js';
import type { ServerEnv } from '../lib/types.js';

export const watcherRoutes = new Hono<ServerEnv>();

// GET /api/watchers — the current user's watchers (cross-thread, newest first)
watcherRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const rows = await db
    .select()
    .from(watchers)
    .where(eq(watchers.userId, userId))
    .orderBy(desc(watchers.createdAt));

  return c.json(rows);
});

// POST /api/watchers/:id/cancel — stop a watcher (ownership-checked)
watcherRoutes.post('/:id/cancel', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(watchers)
    .where(and(eq(watchers.id, id), eq(watchers.userId, userId)));
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);

  // Only live watchers can be cancelled; terminal states stay as they are.
  if (rows[0].status === 'pending' || rows[0].status === 'fired') {
    await db
      .update(watchers)
      .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
      .where(eq(watchers.id, id));
  }

  const updated = await db.select().from(watchers).where(eq(watchers.id, id));
  return c.json(updated[0]);
});
