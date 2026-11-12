/**
 * Agent-job routes for the central server.
 *
 * Jobs (funny-owned detached background processes) are persisted in the server
 * DB; the web client lists them over the `jobs` tRPC procedure
 * (trpc/ports/background.ts), so the bare `GET /api/jobs` is not answered here
 * (app.ts refuses it). Reading the log and cancelling must reach the runner
 * that owns the process, so they are proxied to the user's runner.
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';

export const jobRoutes = new Hono<ServerEnv>();

// GET /api/jobs/:id/log — proxied to the user's runner, which owns the local
// captured logfile. The runner still validates job ownership before reading.
jobRoutes.get('/:id/log', proxyToRunner);

// POST /api/jobs/:id/cancel — proxied to the user's runner, which signals the
// detached process group and marks the job cancelled.
jobRoutes.post('/:id/cancel', proxyToRunner);
