/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: entity
 * @domain layer: domain
 */

import type { WaitingReason } from '@funny/shared';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';

/**
 * Tracks per-thread DB-mapping state for running agents.
 * Lifecycle fields (activeAgents, manuallyStopped) are now owned
 * by AgentOrchestrator in @funny/core.
 */
export class AgentStateTracker {
  /**
   * Threads that received a result message — used by AgentMessageHandler
   * to deduplicate result processing. Separate from the orchestrator's
   * lifecycle-level resultReceived which governs error/exit suppression.
   */
  readonly resultReceived = new Set<string>();

  /**
   * Threads whose `agent:completed` bus event has already been emitted for
   * the current run. Guards against double-fire when both the SDK result
   * path AND a failure/stop path resolve the same run (which would dequeue
   * the next follow-up twice in the queue handler).
   *
   * Cleared by `clearRunState` so the next run can emit normally.
   */
  readonly completedEmitted = new Set<string>();

  /** Current assistant message DB ID per thread */
  readonly currentAssistantMsgId = new Map<string, string>();

  /**
   * CLI tool_use block IDs → our DB toolCallId per thread.
   * Preserved across session resume to deduplicate re-sent content.
   */
  readonly processedToolUseIds = new Map<string, Map<string, string>>();

  /**
   * CLI message IDs → our DB message IDs per thread.
   * Preserved across session resume.
   */
  readonly cliToDbMsgId = new Map<string, Map<string, string>>();

  /** Threads waiting for user input (AskUserQuestion / ExitPlanMode) */
  readonly pendingUserInput = new Map<string, WaitingReason>();

  /** Pending permission requests per thread */
  readonly pendingPermissionRequest = new Map<
    string,
    { toolName: string; toolUseId: string; toolInput?: string }
  >();

  /**
   * Threads whose current run hit a provider error (rate limit / API error)
   * that the agent did NOT recover from. Set when a `ProviderError` tool card
   * is emitted, cleared as soon as the agent makes real progress afterwards.
   * At result time a still-set flag turns the run into a `waiting` state
   * (waitingReason `provider_error`) so the user can resume instead of seeing
   * a misleading "completed".
   */
  readonly providerErrorPending = new Set<string>();

  /** Cumulative input token count per thread (tracks context window usage) */
  readonly cumulativeInputTokens = new Map<string, number>();

  /**
   * Slash commands the SDK reported as available per thread (names without the
   * leading slash, incl. aliases). Captured from the `init` system message and
   * refreshed by `commands_changed`. Used at the send boundary to reject an
   * unknown `/command` with a clear error instead of forwarding it to the model
   * as literal text (the silent "typo'd command does nothing" failure mode).
   */
  readonly supportedSlashCommands = new Map<string, Set<string>>();

  /** Cached userId per thread — avoids DB reads on every WS emission */
  readonly threadUserIds = new Map<string, string>();

  /** Last-activity timestamp per known thread — drives LRU eviction. */
  private readonly touchedAt = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Hard cap on tracked threads; oldest are evicted beyond this. */
  static readonly MAX_TRACKED_THREADS = 500;
  /** Inactive threads older than this are evicted by the periodic sweep. */
  static readonly STALE_THREAD_AGE_MS = 60 * 60 * 1000;
  /** Sweep interval (5 minutes). */
  static readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;

  /**
   * Mark a thread as active. Also enforces the hard cap by evicting the
   * oldest-touched threads when over MAX_TRACKED_THREADS.
   */
  touch(threadId: string): void {
    // Re-insert to move to end of iteration order (LRU).
    this.touchedAt.delete(threadId);
    this.touchedAt.set(threadId, Date.now());
    while (this.touchedAt.size > AgentStateTracker.MAX_TRACKED_THREADS) {
      const oldest = this.touchedAt.keys().next().value;
      if (!oldest) break;
      this.cleanupThread(oldest);
      metric('agent_state.evicted_capacity', 1, { type: 'sum' });
    }
  }

  /**
   * Clear stale state when starting a new agent run.
   * processedToolUseIds and cliToDbMsgId are intentionally preserved
   * across sessions to deduplicate re-sent content on --resume.
   */
  clearRunState(threadId: string): void {
    this.touch(threadId);
    this.currentAssistantMsgId.delete(threadId);
    this.resultReceived.delete(threadId);
    this.completedEmitted.delete(threadId);
    this.pendingUserInput.delete(threadId);
    this.pendingPermissionRequest.delete(threadId);
    this.providerErrorPending.delete(threadId);
    this.cumulativeInputTokens.delete(threadId);
  }

  /** Completely remove all in-memory state for a thread. */
  cleanupThread(threadId: string): void {
    this.touchedAt.delete(threadId);
    this.resultReceived.delete(threadId);
    this.completedEmitted.delete(threadId);
    this.currentAssistantMsgId.delete(threadId);
    this.processedToolUseIds.delete(threadId);
    this.cliToDbMsgId.delete(threadId);
    this.pendingUserInput.delete(threadId);
    this.pendingPermissionRequest.delete(threadId);
    this.providerErrorPending.delete(threadId);
    this.cumulativeInputTokens.delete(threadId);
    this.supportedSlashCommands.delete(threadId);
    this.threadUserIds.delete(threadId);
  }

  /**
   * Evict threads whose last activity is older than maxAgeMs.
   * Safety net when cleanupThread is never called by callers.
   */
  sweepStale(maxAgeMs: number = AgentStateTracker.STALE_THREAD_AGE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    let evicted = 0;
    for (const [threadId, ts] of this.touchedAt) {
      if (ts < cutoff) {
        this.cleanupThread(threadId);
        evicted++;
      }
    }
    return evicted;
  }

  /** Start periodic sweeping. Safe to call multiple times. */
  startAutoSweep(intervalMs: number = AgentStateTracker.SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        const evicted = this.sweepStale();
        if (evicted > 0) {
          log.info('AgentStateTracker swept stale threads', {
            namespace: 'agent-state',
            evicted,
            tracked: this.touchedAt.size,
          });
          metric('agent_state.evicted_stale', evicted, { type: 'sum' });
        }
        metric('agent_state.tracked_threads', this.touchedAt.size, { type: 'gauge' });
      } catch (err: any) {
        log.error('AgentStateTracker sweep failed', {
          namespace: 'agent-state',
          error: err?.message,
        });
      }
    }, intervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  stopAutoSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  get trackedThreadCount(): number {
    return this.touchedAt.size;
  }
}
