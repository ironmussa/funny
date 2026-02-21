/**
 * Pipeline proxy routes — forwards pipeline requests from the UI server
 * to the agent/pipeline server (port 3002).
 *
 * POST /run            → Start a direct pipeline run (no Hatchet needed)
 * POST /workflow       → Trigger a Hatchet workflow
 * GET  /workflow/:runId → Get workflow run status
 * GET  /list           → List all pipeline runs
 */

import { Hono } from 'hono';
import { log } from '../lib/abbacchio.js';

const AGENT_SERVER_URL = process.env.AGENT_SERVER_URL ?? 'http://localhost:3002';

export function createPipelineProxyRoutes(): Hono {
  const app = new Hono();

  // ── POST /run — Start a direct pipeline run ─────────────────

  app.post('/run', async (c) => {
    const body = await c.req.json();

    try {
      const response = await fetch(`${AGENT_SERVER_URL}/pipeline/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const data = await response.json();
      return c.json(data, response.status as any);
    } catch (err: any) {
      log.error('Pipeline proxy error (run)', { namespace: 'pipeline-proxy', error: err.message });
      return c.json({ error: 'Pipeline service unavailable' }, 503);
    }
  });

  // ── POST /workflow — Trigger a Hatchet workflow ────────────────

  app.post('/workflow', async (c) => {
    const body = await c.req.json();

    try {
      const response = await fetch(`${AGENT_SERVER_URL}/pipeline/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const data = await response.json();
      return c.json(data, response.status as any);
    } catch (err: any) {
      log.error('Pipeline proxy error (trigger workflow)', { namespace: 'pipeline-proxy', error: err.message });
      return c.json({ error: 'Pipeline service unavailable' }, 503);
    }
  });

  // ── GET /workflow/:runId — Get workflow run status ──────────────

  app.get('/workflow/:runId', async (c) => {
    const runId = c.req.param('runId');

    try {
      const response = await fetch(`${AGENT_SERVER_URL}/pipeline/workflow/${runId}`, {
        signal: AbortSignal.timeout(10_000),
      });

      const data = await response.json();
      return c.json(data, response.status as any);
    } catch (err: any) {
      log.error('Pipeline proxy error (get workflow)', { namespace: 'pipeline-proxy', error: err.message });
      return c.json({ error: 'Pipeline service unavailable' }, 503);
    }
  });

  // ── GET /list — List all pipeline runs ─────────────────────────

  app.get('/list', async (c) => {
    try {
      const response = await fetch(`${AGENT_SERVER_URL}/pipeline/list`, {
        signal: AbortSignal.timeout(10_000),
      });

      const data = await response.json();
      return c.json(data, response.status as any);
    } catch (err: any) {
      log.error('Pipeline proxy error (list)', { namespace: 'pipeline-proxy', error: err.message });
      return c.json({ error: 'Pipeline service unavailable' }, 503);
    }
  });

  return app;
}
