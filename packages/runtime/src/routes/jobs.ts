/**
 * Agent-job routes for the runtime.
 *
 * Only the operation that needs runtime-side resources lives here: cancelling a
 * job must signal the detached process group on this runner. Listing is handled
 * server-side from the DB.
 */

import { Hono } from 'hono';

import { cancelJob } from '../services/agent-job-manager.js';
import type { HonoEnv } from '../types/hono-env.js';

export const jobRoutes = new Hono<HonoEnv>();

// POST /api/jobs/:id/cancel — signal the job's process group, mark cancelled.
jobRoutes.post('/:id/cancel', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const ok = await cancelJob(c.req.param('id'), userId);
  if (!ok) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
