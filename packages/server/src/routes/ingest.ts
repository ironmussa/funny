/**
 * Ingest webhook route — receives events from external services
 * and translates them into threads/messages visible in the UI.
 *
 * POST /api/ingest/webhook
 *
 * This route is mounted WITHOUT authMiddleware since it uses
 * its own service-to-service authentication via X-Webhook-Secret.
 */

import { Hono } from 'hono';
import { timingSafeEqual } from 'crypto';
import { handleIngestEvent, type IngestEvent } from '../services/ingest-mapper.js';
import { log } from '../lib/abbacchio.js';

const ingestRoutes = new Hono();

const WEBHOOK_SECRET = process.env.INGEST_WEBHOOK_SECRET;

ingestRoutes.post('/webhook', async (c) => {
  // Require webhook secret — reject all requests if not configured
  if (!WEBHOOK_SECRET) {
    return c.json({ error: 'Webhook secret not configured (set INGEST_WEBHOOK_SECRET)' }, 503);
  }

  const provided = c.req.header('X-Webhook-Secret') ?? '';
  if (provided.length !== WEBHOOK_SECRET.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(WEBHOOK_SECRET))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json<IngestEvent>();

  // Validate minimal event structure
  if (!body.event_type || !body.timestamp) {
    return c.json(
      { error: 'Invalid event: event_type and timestamp are required' },
      400,
    );
  }

  // Allow events with empty request_id AND no thread_id (e.g. director.activated, director.cycle.completed)
  // — they are system-level events not tied to a specific pipeline run.
  if (!body.request_id && !body.thread_id) {
    return c.json({ status: 'ok', skipped: true }, 200);
  }

  if (!body.data || typeof body.data !== 'object') {
    return c.json({ error: 'Invalid event: data must be an object' }, 400);
  }

  try {
    handleIngestEvent(body);
    return c.json({ status: 'ok' }, 200);
  } catch (err: any) {
    log.error('Error processing ingest event', { namespace: 'ingest', eventType: body.event_type, error: err.message });
    return c.json({ error: err.message }, 500);
  }
});

export { ingestRoutes };
