/**
 * GitHub webhook inbound endpoint.
 *
 * POST /github — Receives GitHub events:
 *   - pull_request (action=closed, merged=true) → emits 'integration.pr.merged'
 *   - pull_request_review (action=submitted) →
 *       state=changes_requested → triggers pr-review-loop workflow
 *       state=approved → emits pr.approved event to unblock durable wait
 */

import { Hono } from 'hono';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import { isHatchetEnabled, getHatchetClient } from '../hatchet/client.js';
import { logger } from '../infrastructure/logger.js';

// ── HMAC signature validation ────────────────────────────────────

async function verifySignature(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expected = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return signature === expected;
}

// ── Route factory ────────────────────────────────────────────────

export function createWebhookRoutes(
  eventBus: EventBus,
  config: PipelineServiceConfig,
): Hono {
  const app = new Hono();

  app.post('/github', async (c) => {
    const rawBody = await c.req.text();

    // Validate signature if secret is configured
    if (config.webhook_secret) {
      const signature = c.req.header('X-Hub-Signature-256') ?? '';
      if (!signature) {
        return c.json({ error: 'Missing X-Hub-Signature-256 header' }, 401);
      }
      const valid = await verifySignature(config.webhook_secret, rawBody, signature);
      if (!valid) {
        return c.json({ error: 'Invalid signature' }, 401);
      }
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const githubEvent = c.req.header('X-GitHub-Event');
    const integrationPrefix = config.branch.integration_prefix;

    // ── Handle pull_request events (merged PRs) ──────────────────

    if (githubEvent === 'pull_request') {
      if (payload.action !== 'closed' || !payload.pull_request?.merged) {
        return c.json({ status: 'ignored', reason: 'not a merged PR' }, 200);
      }

      const pr = payload.pull_request;
      const headRef: string = pr.head?.ref ?? '';
      const baseRef: string = pr.base?.ref ?? '';
      const mergeCommitSha: string = pr.merge_commit_sha ?? '';
      const prNumber: number = pr.number ?? 0;

      if (!headRef.startsWith(integrationPrefix)) {
        return c.json({ status: 'ignored', reason: 'not an integration branch' }, 200);
      }
      const branch = headRef.slice(integrationPrefix.length);
      const pipelineBranch = `${config.branch.pipeline_prefix}${branch}`;

      logger.info(
        { branch, headRef, baseRef, prNumber, mergeCommitSha },
        'GitHub webhook: PR merged',
      );

      await eventBus.publish({
        event_type: 'integration.pr.merged',
        request_id: `webhook-${prNumber}`,
        timestamp: new Date().toISOString(),
        data: {
          branch,
          integration_branch: headRef,
          pipeline_branch: pipelineBranch,
          base_ref: baseRef,
          merge_commit_sha: mergeCommitSha,
          pr_number: prNumber,
          pr_url: pr.html_url ?? '',
        },
      });

      return c.json({ status: 'processed', branch, pr_number: prNumber }, 200);
    }

    // ── Handle pull_request_review events ────────────────────────

    if (githubEvent === 'pull_request_review') {
      if (payload.action !== 'submitted') {
        return c.json({ status: 'ignored', reason: 'not a submitted review' }, 200);
      }

      const review = payload.review;
      const pr = payload.pull_request;
      const headRef: string = pr?.head?.ref ?? '';
      const prNumber: number = pr?.number ?? 0;
      const prUrl: string = pr?.html_url ?? '';
      const reviewState: string = review?.state?.toLowerCase() ?? '';

      // Only handle reviews on integration branches
      if (!headRef.startsWith(integrationPrefix)) {
        return c.json({ status: 'ignored', reason: 'not an integration branch' }, 200);
      }

      const branch = headRef.slice(integrationPrefix.length);

      if (reviewState === 'approved') {
        logger.info({ branch, prNumber, reviewer: review?.user?.login }, 'PR approved via webhook');

        // Emit pr.approved event to Hatchet to unblock the durable wait
        if (isHatchetEnabled()) {
          const hatchet = getHatchetClient();
          await hatchet.event.push('pr.approved', { prNumber, branch });
        }

        await eventBus.publish({
          event_type: 'review_loop.completed',
          request_id: `review-${prNumber}`,
          timestamp: new Date().toISOString(),
          data: { branch, pr_number: prNumber, reason: 'approved' },
        });

        return c.json({ status: 'processed', action: 'pr_approved', branch }, 200);
      }

      if (reviewState === 'changes_requested') {
        logger.info(
          { branch, prNumber, reviewer: review?.user?.login },
          'Changes requested on PR — triggering review loop',
        );

        await eventBus.publish({
          event_type: 'review_loop.started',
          request_id: `review-${prNumber}-${Date.now()}`,
          timestamp: new Date().toISOString(),
          data: { branch, pr_number: prNumber, reviewer: review?.user?.login ?? '' },
        });

        // Trigger the pr-review-loop workflow via Hatchet
        if (isHatchetEnabled()) {
          const hatchet = getHatchetClient();
          await hatchet.runNoWait('pr-review-loop', {
            projectPath: process.env.PROJECT_PATH ?? process.cwd(),
            branch,
            integrationBranch: headRef,
            prNumber,
            prUrl,
            baseBranch: config.branch.main,
          }, {});
        }

        return c.json({ status: 'processed', action: 'review_loop_triggered', branch }, 200);
      }

      return c.json({ status: 'ignored', reason: `review state: ${reviewState}` }, 200);
    }

    return c.json({ status: 'ignored', reason: `event type: ${githubEvent}` }, 200);
  });

  return app;
}
