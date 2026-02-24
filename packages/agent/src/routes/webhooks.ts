/**
 * GitHub webhook inbound endpoint.
 *
 * POST /github — Receives GitHub events:
 *   - pull_request (action=closed, merged=true) → emits 'session.merged'
 *   - pull_request_review (action=submitted) →
 *       state=changes_requested → emits 'session.changes_requested'
 *       state=approved → emits 'session.review_requested'
 *   - check_suite (conclusion) → emits 'session.ci_passed' / 'session.ci_failed'
 */

import { Hono } from 'hono';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { PipelineServiceConfig } from '../config/schema.js';
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

    // ── Handle pull_request events (merged PRs) ──────────────────

    if (githubEvent === 'pull_request') {
      if (payload.action !== 'closed' || !payload.pull_request?.merged) {
        return c.json({ status: 'ignored', reason: 'not a merged PR' }, 200);
      }

      const pr = payload.pull_request;
      const headRef: string = pr.head?.ref ?? '';
      const prNumber: number = pr.number ?? 0;
      const mergeCommitSha: string = pr.merge_commit_sha ?? '';

      // Extract issue number from branch name (e.g., "issue/42/slug")
      const issueMatch = headRef.match(/^issue\/(\d+)/);
      const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : null;

      logger.info({ headRef, prNumber, mergeCommitSha, issueNumber }, 'GitHub webhook: PR merged');

      await eventBus.publish({
        event_type: 'session.merged',
        request_id: `webhook-${prNumber}`,
        timestamp: new Date().toISOString(),
        data: {
          branch: headRef,
          merge_commit_sha: mergeCommitSha,
          pr_number: prNumber,
          pr_url: pr.html_url ?? '',
          issueNumber,
        },
      });

      return c.json({ status: 'processed', branch: headRef, pr_number: prNumber }, 200);
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
      const reviewState: string = review?.state?.toLowerCase() ?? '';

      // Extract issue number from branch name
      const issueMatch = headRef.match(/^issue\/(\d+)/);
      const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : null;

      if (reviewState === 'approved') {
        logger.info({ headRef, prNumber, reviewer: review?.user?.login }, 'PR approved via webhook');

        await eventBus.publish({
          event_type: 'session.review_requested',
          request_id: `review-${prNumber}`,
          timestamp: new Date().toISOString(),
          data: { branch: headRef, prNumber, issueNumber, approved: true },
        });

        return c.json({ status: 'processed', action: 'pr_approved', branch: headRef }, 200);
      }

      if (reviewState === 'changes_requested') {
        logger.info(
          { headRef, prNumber, reviewer: review?.user?.login },
          'Changes requested on PR',
        );

        await eventBus.publish({
          event_type: 'session.changes_requested',
          request_id: `review-${prNumber}-${Date.now()}`,
          timestamp: new Date().toISOString(),
          data: { branch: headRef, prNumber, issueNumber },
        });

        return c.json({ status: 'processed', action: 'changes_requested', branch: headRef }, 200);
      }

      return c.json({ status: 'ignored', reason: `review state: ${reviewState}` }, 200);
    }

    // ── Handle check_suite events (CI status) ──────────────────

    if (githubEvent === 'check_suite') {
      const checkSuite = payload.check_suite;
      const conclusion: string = checkSuite?.conclusion ?? '';
      const headBranch: string = checkSuite?.head_branch ?? '';
      const headSha: string = checkSuite?.head_sha ?? '';

      if (!conclusion || !headBranch) {
        return c.json({ status: 'ignored', reason: 'incomplete check_suite data' }, 200);
      }

      // Extract issue number from branch name (e.g., "issue/42/slug")
      const issueMatch = headBranch.match(/^issue\/(\d+)/);
      const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : null;

      if (conclusion === 'success') {
        logger.info({ headBranch, headSha }, 'CI passed via check_suite webhook');

        await eventBus.publish({
          event_type: 'session.ci_passed',
          request_id: `ci-${headSha.slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          data: { branch: headBranch, sha: headSha, issueNumber },
        });

        return c.json({ status: 'processed', action: 'ci_passed', branch: headBranch }, 200);
      }

      if (conclusion === 'failure' || conclusion === 'timed_out') {
        logger.info({ headBranch, headSha, conclusion }, 'CI failed via check_suite webhook');

        await eventBus.publish({
          event_type: 'session.ci_failed',
          request_id: `ci-${headSha.slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          data: { branch: headBranch, sha: headSha, conclusion, issueNumber },
        });

        return c.json({ status: 'processed', action: 'ci_failed', branch: headBranch }, 200);
      }

      return c.json({ status: 'ignored', reason: `conclusion: ${conclusion}` }, 200);
    }

    return c.json({ status: 'ignored', reason: `event type: ${githubEvent}` }, 200);
  });

  return app;
}
