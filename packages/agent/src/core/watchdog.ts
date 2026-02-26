/**
 * Watchdog — declarative event-driven responses.
 *
 * Listens to EventBus events (CI failures, review comments, stuck agents)
 * and executes configured actions: respawn agent, escalate, notify, auto-merge.
 *
 * All behavior is config-driven — no hardcoded logic.
 */

import type { PipelineServiceConfig } from '../config/schema.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { logger } from '../infrastructure/logger.js';
import type { SessionStore } from './session-store.js';
import type { PipelineEvent } from './types.js';

// ── Reaction types ──────────────────────────────────────────────

export type ReactionAction = 'respawn_agent' | 'notify' | 'escalate' | 'auto_merge';

export interface ReactionResult {
  sessionId: string;
  trigger: string;
  action: ReactionAction;
  success: boolean;
  message: string;
}

// ── Watchdog ──────────────────────────────────────────────

export class Watchdog {
  private stuckTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private eventBus: EventBus,
    private sessionStore: SessionStore,
    private config: PipelineServiceConfig,
    private handlers: {
      respawnAgent: (sessionId: string, prompt: string) => Promise<void>;
      notify: (sessionId: string, message: string) => Promise<void>;
      autoMerge: (sessionId: string) => Promise<void>;
    },
  ) {}

  /** Start listening to events */
  start(): void {
    this.eventBus.on('event', (event: PipelineEvent) => {
      this.handleEvent(event).catch((err) => {
        logger.error({ err: err.message, eventType: event.event_type }, 'Reaction handler failed');
      });
    });

    logger.info('Watchdog started');
  }

  /** Stop all timers */
  stop(): void {
    for (const timer of this.stuckTimers.values()) {
      clearTimeout(timer);
    }
    this.stuckTimers.clear();
  }

  // ── Event handling ────────────────────────────────────────────

  private async handleEvent(event: PipelineEvent): Promise<void> {
    const { event_type, data } = event;

    switch (event_type) {
      case 'session.ci_failed':
        await this.onCIFailed(event);
        break;

      case 'session.changes_requested':
        await this.onChangesRequested(event);
        break;

      case 'session.ci_passed':
        await this.onCIPassed(event);
        break;

      case 'session.implementing':
      case 'session.pr_created':
        this.startStuckTimer(data.sessionId as string);
        break;

      case 'session.merged':
      case 'session.failed':
      case 'session.escalated':
        this.clearStuckTimer(data.sessionId as string);
        break;
    }
  }

  // ── CI Failed ─────────────────────────────────────────────────

  private async onCIFailed(event: PipelineEvent): Promise<void> {
    const sessionId = event.data.sessionId as string;
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    const reaction = this.config.reactions.ci_failed;
    const attempts = session.incrementCIAttempts();

    await this.publishReaction(sessionId, 'ci_failed', reaction.action, {
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

  // ── Changes Requested ─────────────────────────────────────────

  private async onChangesRequested(event: PipelineEvent): Promise<void> {
    const sessionId = event.data.sessionId as string;
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    const reaction = this.config.reactions.changes_requested;
    const attempts = session.incrementReviewAttempts();

    await this.publishReaction(sessionId, 'changes_requested', reaction.action, {
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

  // ── CI Passed (check if also approved → auto-merge) ───────────

  private async onCIPassed(event: PipelineEvent): Promise<void> {
    const sessionId = event.data.sessionId as string;
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    const reaction = this.config.reactions.approved_and_green;

    // Check if PR is also approved
    const isApproved = event.data.prApproved === true;
    if (!isApproved) return;

    if (reaction.action === 'auto_merge' && this.config.sessions.auto_merge) {
      await this.handlers.autoMerge(sessionId);
      await this.publishReaction(sessionId, 'approved_and_green', 'auto_merge', {});
      logger.info({ sessionId }, 'Auto-merging approved + green PR');
    } else {
      const message = this.interpolate(reaction.message, session);
      await this.handlers.notify(sessionId, message);
    }
  }

  // ── Stuck detection ───────────────────────────────────────────

  private startStuckTimer(sessionId: string): void {
    this.clearStuckTimer(sessionId);

    const afterMin = this.config.reactions.agent_stuck.after_min;
    if (afterMin <= 0) return;

    const timer = setTimeout(async () => {
      const session = this.sessionStore.get(sessionId);
      if (!session || !session.isActive) return;

      const reaction = this.config.reactions.agent_stuck;
      if (reaction.action === 'escalate') {
        await this.escalate(sessionId, this.interpolate(reaction.message, session));
      } else {
        await this.handlers.notify(sessionId, this.interpolate(reaction.message, session));
      }
    }, afterMin * 60_000);

    this.stuckTimers.set(sessionId, timer);
  }

  private clearStuckTimer(sessionId: string): void {
    const timer = this.stuckTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.stuckTimers.delete(sessionId);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private async escalate(sessionId: string, reason: string): Promise<void> {
    await this.sessionStore.transition(sessionId, 'escalated', { reason });
    await this.handlers.notify(sessionId, `Escalated: ${reason}`);
    this.clearStuckTimer(sessionId);
  }

  private async publishReaction(
    sessionId: string,
    trigger: string,
    action: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.eventBus.publish({
      event_type: 'reaction.triggered' as any,
      request_id: sessionId,
      timestamp: new Date().toISOString(),
      data: { sessionId, trigger, action, ...data },
    });
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
