/**
 * Pipeline REST routes for the central server: the approval gates, which are
 * answered by the runner that runs the pipeline. Pipeline CRUD and run history
 * are served by the `pipelines` tRPC procedures.
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import { refuseRetiredRoute } from './retired-rest.js';

export const pipelineRoutes = new Hono<ServerEnv>();

// ── Approval gates ────────────────────────────────────────────
pipelineRoutes.post('/approvals/:approvalId/respond', proxyToRunner);
pipelineRoutes.get('/approvals/pending', proxyToRunner);

// ── Everything else ───────────────────────────────────────
// Pipeline CRUD and run history moved to the `pipelines` tRPC procedures
// (openspec adopt-trpc-browser-api). Any other path answers 404 here instead of
// falling through to the runner proxy.
pipelineRoutes.all('*', refuseRetiredRoute);
