/**
 * GitHub webhook route for PR reviews.
 *
 * POST /api/review/webhook
 *
 * Receives GitHub `pull_request` events and triggers a reviewbot review.
 * Mounted WITHOUT authMiddleware — uses webhook secret for auth.
 */

import { timingSafeEqual } from 'crypto';

import { Hono } from 'hono';

import { log } from '../lib/logger.js';
import { handlePRWebhook, type PRWebhookPayload } from '../services/review-service.js';

const reviewWebhookRoutes = new Hono();

const WEBHOOK_SECRET = process.env.REVIEW_WEBHOOK_SECRET;

reviewWebhookRoutes.post('/webhook', async (c) => {
  // Validate webhook secret
  if (!WEBHOOK_SECRET) {
    return c.json({ error: 'Webhook secret not configured (set REVIEW_WEBHOOK_SECRET)' }, 503);
  }

  const provided = c.req.header('X-Webhook-Secret') ?? c.req.header('X-Hub-Signature-256') ?? '';
  if (
    provided.length !== WEBHOOK_SECRET.length ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(WEBHOOK_SECRET))
  ) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Only process pull_request events
  const githubEvent = c.req.header('X-GitHub-Event');
  if (githubEvent && githubEvent !== 'pull_request') {
    return c.json({ status: 'ok', skipped: true, reason: `Ignoring event: ${githubEvent}` }, 200);
  }

  const body = await c.req.json<PRWebhookPayload>();

  // Validate minimal payload structure
  if (!body.action || !body.number || !body.pull_request || !body.repository) {
    return c.json({ error: 'Invalid payload: missing required fields' }, 400);
  }

  try {
    const result = await handlePRWebhook(body);

    if (!result) {
      return c.json(
        { status: 'ok', skipped: true, reason: 'No matching project or ignored action' },
        200,
      );
    }

    return c.json({ status: 'ok', thread_id: result.threadId }, 200);
  } catch (err: any) {
    log.error('Error processing PR webhook', { namespace: 'reviewbot', error: err.message });
    return c.json({ error: err.message }, 500);
  }
});

export { reviewWebhookRoutes };
