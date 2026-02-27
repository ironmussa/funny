/**
 * CIRetryWorkflow — reacts to CI failures by respawning the agent
 * or escalating after the retry budget is exhausted.
 *
 * Extracted from Watchdog.onCIFailed().
 */

import type { PipelineServiceConfig } from '../config/schema.js';
import type { SessionStore } from '../core/session-store.js';
import type { PipelineEvent } from '../core/types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { logger } from '../infrastructure/logger.js';
import type { IWorkflow } from './types.js';
import { WorkflowEventEmitter } from './workflow-event-emitter.js';

export interface CIRetryWorkflowDeps {
  eventBus: EventBus;
  sessionStore: SessionStore;
  config: PipelineServiceConfig;
  handlers: {
    respawnAgent: (sessionId: string, prompt: string) => Promise<void>;
    notify: (sessionId: string, message: string) => Promise<void>;
  };
}

export class CIRetryWorkflow implements IWorkflow {
  readonly name = 'ci-retry';

  private eventBus: EventBus;
  private emitter: WorkflowEventEmitter;
  private sessionStore: SessionStore;
  private config: PipelineServiceConfig;
  private handlers: CIRetryWorkflowDeps['handlers'];
  private unsubscribe: (() => void) | null = null;

  constructor(deps: CIRetryWorkflowDeps) {
    this.eventBus = deps.eventBus;
    this.emitter = new WorkflowEventEmitter(deps.eventBus);
    this.sessionStore = deps.sessionStore;
    this.config = deps.config;
    this.handlers = deps.handlers;
  }

  start(): void {
    this.unsubscribe = this.eventBus.onEventType('session.ci_failed', (event) => {
      this.onCIFailed(event).catch((err) => {
        logger.error({ err: err.message }, 'CIRetryWorkflow handler failed');
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async onCIFailed(event: PipelineEvent): Promise<void> {
    const sessionId = event.data.sessionId as string;
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    const reaction = this.config.reactions.ci_failed;
    const attempts = session.incrementCIAttempts();

    await this.emitter.emit('reaction.triggered', sessionId, {
      sessionId,
      trigger: 'ci_failed',
      action: reaction.action,
      attempts,
      maxRetries: reaction.max_retries,
    });

    if (attempts > reaction.max_retries) {
      logger.warn({ sessionId, attempts }, 'CI retry budget exhausted — escalating');
      await this.escalate(sessionId, `CI failed ${attempts} times — exceeded retry budget`);
      return;
    }

    if (reaction.action === 'respawn_agent') {
      const prompt = this.interpolate(reaction.prompt, session);
      await this.handlers.respawnAgent(sessionId, prompt);
      logger.info({ sessionId, attempt: attempts }, 'Agent respawned for CI fix');
    } else if (reaction.action === 'escalate') {
      await this.escalate(sessionId, 'CI failed — configured to escalate immediately');
    } else {
      await this.handlers.notify(
        sessionId,
        `CI failed on session ${sessionId} (attempt ${attempts})`,
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
