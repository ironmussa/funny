/**
 * Agent-job routes for the central server.
 *
 * Jobs (funny-owned detached background processes) are persisted in the server
 * DB, so list reads directly here. Cancel, however, must reach the runner to
 * signal the process group of the detached process — so it is proxied to the
 * user's runner (server-direct DB write alone wouldn't kill the process).
 */

import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/index.js';
import { jobs } from '../db/schema.js';
import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';

export const jobRoutes = new Hono<ServerEnv>();

// GET /api/jobs — the current user's jobs (newest first)
jobRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const rows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.userId, userId))
    .orderBy(desc(jobs.startedAt));

  return c.json(rows);
});

// POST /api/jobs/:id/cancel — proxied to the user's runner, which signals the
// detached process group and marks the job cancelled.
jobRoutes.post('/:id/cancel', proxyToRunner);
