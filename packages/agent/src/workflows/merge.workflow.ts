/**
 * MergeWorkflow — auto-merges PRs when CI passes and the PR is approved,
 * and detects stuck sessions.
 *
 * Extracted from Watchdog.onCIPassed() and stuck detection.
 */

import type { PipelineServiceConfig } from '../config/schema.js';
import type { SessionStore } from '../core/session-store.js';
import type { PipelineEvent } from '../core/types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { logger } from '../infrastructure/logger.js';
import type { IWorkflow } from './types.js';
import { WorkflowEventEmitter } from './workflow-event-emitter.js';

export interface MergeWorkflowDeps {
  eventBus: EventBus;
  sessionStore: SessionStore;
  config: PipelineServiceConfig;
  handlers: {
    autoMerge: (sessionId: string) => Promise<void>;
    notify: (sessionId: string, message: string) => Promise<void>;
  };
}

export class MergeWorkflow implements IWorkflow {
  readonly name = 'merge';

  private eventBus: EventBus;
  private emitter: WorkflowEventEmitter;
  private sessionStore: SessionStore;
  private config: PipelineServiceConfig;
  private handlers: MergeWorkflowDeps['handlers'];
  private unsubscribers: (() => void)[] = [];
  private stuckTimers = new Map<string, NodeJS.Timeout>();

  constructor(deps: MergeWorkflowDeps) {
    this.eventBus = deps.eventBus;
    this.emitter = new WorkflowEventEmitter(deps.eventBus);
    this.sessionStore = deps.sessionStore;
    this.config = deps.config;
    this.handlers = deps.handlers;
  }

  start(): void {
    this.unsubscribers.push(
      this.eventBus.onEventType('session.ci_passed', (event) => {
        this.onCIPassed(event).catch((err) => {
          logger.error({ err: err.message }, 'MergeWorkflow ci_passed handler failed');
        });
      }),
    );

    // Stuck detection — start timer on implementing/pr_created
    this.unsubscribers.push(
      this.eventBus.onEventTypes(['session.implementing', 'session.pr_created'], (event) => {
        this.startStuckTimer(event.data.sessionId as string);
      }),
    );

    // Clear stuck timer on terminal events
    this.unsubscribers.push(
      this.eventBus.onEventTypes(
        ['session.merged', 'session.failed', 'session.escalated'],
        (event) => {
          this.clearStuckTimer(event.data.sessionId as string);
        },
      ),
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    for (const timer of this.stuckTimers.values()) clearTimeout(timer);
    this.stuckTimers.clear();
  }

  private async onCIPassed(event: PipelineEvent): Promise<void> {
    const sessionId = event.data.sessionId as string;
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    const reaction = this.config.reactions.approved_and_green;
    const isApproved = event.data.prApproved === true;
    if (!isApproved) return;

    if (reaction.action === 'auto_merge' && this.config.sessions.auto_merge) {
      await this.handlers.autoMerge(sessionId);
      await this.emitter.emit('reaction.auto_merged', sessionId, { sessionId });
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
        await this.sessionStore.transition(sessionId, 'escalated', {
          reason: this.interpolate(reaction.message, session),
        });
        await this.handlers.notify(
          sessionId,
          `Escalated: ${this.interpolate(reaction.message, session)}`,
        );
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

  private interpolate(
    template: string,
    session: { issue: { number: number }; prNumber: number | null },
  ): string {
    return template
      .replace(/#\{issueNumber\}/g, String(session.issue.number))
      .replace(/#\{prNumber\}/g, String(session.prNumber ?? ''));
  }
}
