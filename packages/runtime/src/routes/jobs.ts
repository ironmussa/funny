/**
 * Agent-job routes for the runtime.
 *
 * Only the operation that needs runtime-side resources lives here: cancelling a
 * job must signal the detached process group on this runner. Listing is handled
 * server-side from the DB.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { cancelJob, readJobLog } from '../services/agent-job-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { parseQuery } from '../validation/request.js';

export const jobRoutes = new Hono<HonoEnv>();

const jobLogQuerySchema = z.object({
  offset: z.coerce.number().default(0),
});

// GET /api/jobs/:id/log — read a captured logfile chunk from this runner.
jobRoutes.get('/:id/log', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = parseQuery(c, jobLogQuerySchema);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { offset } = parsed.value;

  const chunk = await readJobLog(c.req.param('id'), userId, offset);
  if (!chunk) return c.json({ error: 'Not found' }, 404);
  return c.json(chunk);
});

// POST /api/jobs/:id/cancel — signal the job's process group, mark cancelled.
jobRoutes.post('/:id/cancel', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const ok = await cancelJob(c.req.param('id'), userId);
  if (!ok) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
