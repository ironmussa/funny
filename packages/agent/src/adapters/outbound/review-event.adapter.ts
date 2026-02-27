/**
 * ReviewEventAdapter — listens to EventBus for PR review events and triggers
 * automated code review via PRReviewer.
 *
 * When a `session.review_requested` event arrives with a `prNumber`,
 * this adapter spawns a PRReviewer, runs the review, and publishes
 * the result back to the EventBus.
 *
 * Previously named ReviewHandler; moved from agents/reviewer/ to adapters/outbound/
 * because it's an adapter (EventBus → Agent), not an agent itself.
 */

import { PRReviewer } from '../../agents/reviewer/index.js';
import type { EventBus } from '../../infrastructure/event-bus.js';
import { logger } from '../../infrastructure/logger.js';

export interface ReviewEventAdapterConfig {
  /** Default project path (used when event data doesn't include one) */
  projectPath: string;
  /** Model to use for reviews (default: claude-sonnet-4-5-20250929) */
  model?: string;
  /** Provider to use (default: claude) */
  provider?: string;
  /** Optional PRReviewer instance (for testing / DI) */
  reviewer?: PRReviewer;
}

export class ReviewEventAdapter {
  private eventBus: EventBus;
  private config: ReviewEventAdapterConfig;
  private reviewer: PRReviewer;
  private unsubscribe: (() => void) | null = null;

  constructor(eventBus: EventBus, config: ReviewEventAdapterConfig) {
    this.eventBus = eventBus;
    this.config = config;
    this.reviewer = config.reviewer ?? new PRReviewer();
  }

  start(): void {
    this.unsubscribe = this.eventBus.onEventType('session.review_requested', (event) => {
      const prNumber = event.data.prNumber as number | undefined;
      if (!prNumber) {
        logger.warn({ requestId: event.request_id }, 'Review event missing prNumber, skipping');
        return;
      }

      const projectPath = (event.data.projectPath as string) || this.config.projectPath;

      this.runReview(event.request_id, projectPath, prNumber).catch((err) => {
        logger.error({ err: err.message, prNumber }, 'ReviewEventAdapter: unhandled error');
      });
    });

    logger.info('ReviewEventAdapter started — listening for session.review_requested events');
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private async runReview(requestId: string, cwd: string, prNumber: number): Promise<void> {
    logger.info({ requestId, prNumber, cwd }, 'Starting automated code review');

    try {
      const result = await this.reviewer.review(cwd, prNumber, {
        model: this.config.model,
        provider: this.config.provider,
        post: true,
      });

      logger.info(
        {
          prNumber,
          status: result.status,
          findings: result.findings.length,
          duration_ms: result.duration_ms,
        },
        'Code review completed',
      );

      await this.eventBus.publish({
        event_type: 'reaction.triggered',
        request_id: requestId,
        timestamp: new Date().toISOString(),
        data: {
          type: 'review_completed',
          prNumber,
          status: result.status,
          summary: result.summary,
          findingsCount: result.findings.length,
          duration_ms: result.duration_ms,
        },
      });
    } catch (err: any) {
      logger.error({ requestId, prNumber, err: err.message }, 'Code review failed');

      await this.eventBus.publish({
        event_type: 'reaction.triggered',
        request_id: requestId,
        timestamp: new Date().toISOString(),
        data: {
          type: 'review_failed',
          prNumber,
          error: err.message,
        },
      });
    }
  }
}
