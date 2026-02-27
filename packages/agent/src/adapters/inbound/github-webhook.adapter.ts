/**
 * GitHubWebhookAdapter — parses GitHub webhook payloads and translates
 * them into internal PipelineEvents published to the EventBus.
 *
 * This adapter handles the inbound translation layer:
 *   GitHub JSON payload → PipelineEvent
 *
 * The HTTP route in routes/webhooks.ts handles signature validation
 * and delegates the parsed payload to this adapter.
 */

import type { EventBus } from '../../infrastructure/event-bus.js';
import { logger } from '../../infrastructure/logger.js';

export interface GitHubWebhookResult {
  status: 'processed' | 'ignored';
  action?: string;
  branch?: string;
  pr_number?: number;
  reason?: string;
}

export class GitHubWebhookAdapter {
  constructor(
    private eventBus: EventBus,
    private projectPath?: string,
  ) {}

  async handle(githubEvent: string, payload: any): Promise<GitHubWebhookResult> {
    switch (githubEvent) {
      case 'pull_request':
        return this.handlePullRequest(payload);
      case 'pull_request_review':
        return this.handlePullRequestReview(payload);
      case 'check_suite':
        return this.handleCheckSuite(payload);
      default:
        return { status: 'ignored', reason: `event type: ${githubEvent}` };
    }
  }

  private async handlePullRequest(payload: any): Promise<GitHubWebhookResult> {
    const pr = payload.pull_request;
    const headRef: string = pr?.head?.ref ?? '';
    const prNumber: number = pr?.number ?? 0;
    const issueNumber = this.extractIssueNumber(headRef);

    if (payload.action === 'opened' || payload.action === 'synchronize') {
      logger.info(
        { headRef, prNumber, action: payload.action },
        'GitHub webhook: PR opened/updated — triggering review',
      );

      await this.eventBus.publish({
        event_type: 'session.review_requested',
        request_id: `review-${prNumber}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        data: {
          branch: headRef,
          prNumber,
          issueNumber,
          pr_url: pr?.html_url ?? '',
          action: payload.action,
          projectPath: this.projectPath,
        },
      });

      return {
        status: 'processed',
        action: 'review_triggered',
        branch: headRef,
        pr_number: prNumber,
      };
    }

    if (payload.action === 'closed' && pr?.merged) {
      const mergeCommitSha: string = pr.merge_commit_sha ?? '';

      logger.info({ headRef, prNumber, mergeCommitSha, issueNumber }, 'GitHub webhook: PR merged');

      await this.eventBus.publish({
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

      return { status: 'processed', branch: headRef, pr_number: prNumber };
    }

    return { status: 'ignored', reason: `pull_request action: ${payload.action}` };
  }

  private async handlePullRequestReview(payload: any): Promise<GitHubWebhookResult> {
    if (payload.action !== 'submitted') {
      return { status: 'ignored', reason: 'not a submitted review' };
    }

    const review = payload.review;
    const pr = payload.pull_request;
    const headRef: string = pr?.head?.ref ?? '';
    const prNumber: number = pr?.number ?? 0;
    const reviewState: string = review?.state?.toLowerCase() ?? '';
    const issueNumber = this.extractIssueNumber(headRef);

    if (reviewState === 'approved') {
      logger.info({ headRef, prNumber, reviewer: review?.user?.login }, 'PR approved via webhook');

      await this.eventBus.publish({
        event_type: 'session.review_requested',
        request_id: `review-${prNumber}`,
        timestamp: new Date().toISOString(),
        data: { branch: headRef, prNumber, issueNumber, approved: true },
      });

      return { status: 'processed', action: 'pr_approved', branch: headRef };
    }

    if (reviewState === 'changes_requested') {
      logger.info({ headRef, prNumber, reviewer: review?.user?.login }, 'Changes requested on PR');

      await this.eventBus.publish({
        event_type: 'session.changes_requested',
        request_id: `review-${prNumber}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        data: { branch: headRef, prNumber, issueNumber },
      });

      return { status: 'processed', action: 'changes_requested', branch: headRef };
    }

    return { status: 'ignored', reason: `review state: ${reviewState}` };
  }

  private async handleCheckSuite(payload: any): Promise<GitHubWebhookResult> {
    const checkSuite = payload.check_suite;
    const conclusion: string = checkSuite?.conclusion ?? '';
    const headBranch: string = checkSuite?.head_branch ?? '';
    const headSha: string = checkSuite?.head_sha ?? '';

    if (!conclusion || !headBranch) {
      return { status: 'ignored', reason: 'incomplete check_suite data' };
    }

    const issueNumber = this.extractIssueNumber(headBranch);

    if (conclusion === 'success') {
      logger.info({ headBranch, headSha }, 'CI passed via check_suite webhook');

      await this.eventBus.publish({
        event_type: 'session.ci_passed',
        request_id: `ci-${headSha.slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        data: { branch: headBranch, sha: headSha, issueNumber },
      });

      return { status: 'processed', action: 'ci_passed', branch: headBranch };
    }

    if (conclusion === 'failure' || conclusion === 'timed_out') {
      logger.info({ headBranch, headSha, conclusion }, 'CI failed via check_suite webhook');

      await this.eventBus.publish({
        event_type: 'session.ci_failed',
        request_id: `ci-${headSha.slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        data: { branch: headBranch, sha: headSha, conclusion, issueNumber },
      });

      return { status: 'processed', action: 'ci_failed', branch: headBranch };
    }

    return { status: 'ignored', reason: `conclusion: ${conclusion}` };
  }

  /** Extract issue number from branch name (e.g., "issue/42/slug" → 42) */
  private extractIssueNumber(branch: string): number | null {
    const match = branch.match(/^issue\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }
}
