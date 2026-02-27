/**
 * ReviewWorkflow — reacts to review feedback (changes_requested) by
 * respawning the agent or escalating after the retry budget is exhausted.
 *
 * Extracted from Watchdog.onChangesRequested().
 */

import type { PipelineServiceConfig } from '../config/schema.js';
import type { SessionStore } from '../core/session-store.js';
import type { PipelineEvent } from '../core/types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { logger } from '../infrastructure/logger.js';
import type { IWorkflow } from './types.js';
import { WorkflowEventEmitter } from './workflow-event-emitter.js';

export interface ReviewWorkflowDeps {
  eventBus: EventBus;
  sessionStore: SessionStore;
  config: PipelineServiceConfig;
  handlers: {
    respawnAgent: (sessionId: string, prompt: string) => Promise<void>;
    notify: (sessionId: string, message: string) => Promise<void>;
  };
}

export class ReviewWorkflow implements IWorkflow {
  readonly name = 'review';

  private eventBus: EventBus;
  private emitter: WorkflowEventEmitter;
  private sessionStore: SessionStore;
  private config: PipelineServiceConfig;
  private handlers: ReviewWorkflowDeps['handlers'];
  private unsubscribe: (() => void) | null = null;

  constructor(deps: ReviewWorkflowDeps) {
    this.eventBus = deps.eventBus;
    this.emitter = new WorkflowEventEmitter(deps.eventBus);
    this.sessionStore = deps.sessionStore;
    this.config = deps.config;
    this.handlers = deps.handlers;
  }

  start(): void {
    this.unsubscribe = this.eventBus.onEventType('session.changes_requested', (event) => {
      this.onChangesRequested(event).catch((err) => {
        logger.error({ err: err.message }, 'ReviewWorkflow handler failed');
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async onChangesRequested(event: PipelineEvent): Promise<void> {
    const sessionId = event.data.sessionId as string;
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    const reaction = this.config.reactions.changes_requested;
    const attempts = session.incrementReviewAttempts();

    await this.emitter.emit('reaction.triggered', sessionId, {
      sessionId,
      trigger: 'changes_requested',
      action: reaction.action,
      attempts,
      maxRetries: reaction.max_retries,
    });

    if (attempts > reaction.max_retries) {
      logger.warn({ sessionId, attempts }, 'Review retry budget exhausted — escalating');
      await this.escalate(
        sessionId,
        `Review changes requested ${attempts} times — exceeded retry budget`,
      );
      return;
    }

    if (reaction.action === 'respawn_agent') {
      const prompt = this.interpolate(reaction.prompt, session);
      await this.handlers.respawnAgent(sessionId, prompt);
      logger.info({ sessionId, attempt: attempts }, 'Agent respawned for review feedback');
    } else if (reaction.action === 'escalate') {
      await this.escalate(sessionId, 'Changes requested — configured to escalate immediately');
    } else {
      await this.handlers.notify(
        sessionId,
        `Review changes requested on session ${sessionId} (attempt ${attempts})`,
      );
    }
  }

  private async escalate(sessionId: string, reason: string): Promise<void> {
    await this.sessionStore.transition(sessionId, 'escalated', { reason });
    await this.handlers.notify(sessionId, `Escalated: ${reason}`);
  }

  private interpolate(
    template: string,
    session: { issue: { number: number }; prNumber: number | null },
  ): string {
    return template
      .replace(/#\{issueNumber\}/g, String(session.issue.number))
      .replace(/#\{prNumber\}/g, String(session.prNumber ?? ''));
  }
}
