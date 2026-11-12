/**
 * Agent-job routes for the central server.
 *
 * Jobs (funny-owned detached background processes) are persisted in the server
 * DB, so list reads directly here. Cancel, however, must reach the runner to
 * signal the process group of the detached process — so it is proxied to the
 * user's runner (server-direct DB write alone wouldn't kill the process).
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import { jobsPort as port } from '../trpc/ports/background.js';
import { answerJson } from '../trpc/reply.js';

export const jobRoutes = new Hono<ServerEnv>();

// GET /api/jobs — the current user's jobs (newest first); shared with the
// `jobs` tRPC router (trpc/ports/background.ts).
jobRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  return answerJson(c, port.list(userId));
});

// GET /api/jobs/:id/log — proxied to the user's runner, which owns the local
// captured logfile. The runner still validates job ownership before reading.
jobRoutes.get('/:id/log', proxyToRunner);

// POST /api/jobs/:id/cancel — proxied to the user's runner, which signals the
// detached process group and marks the job cancelled.
jobRoutes.post('/:id/cancel', proxyToRunner);
