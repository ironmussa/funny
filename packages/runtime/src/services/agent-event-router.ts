/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: event-handler
 * @domain layer: application
 * @domain emits: agent:completed
 * @domain depends: AgentOrchestrator, AgentStateTracker, AgentMessageHandler, ThreadManager, WSBroker, ThreadEventBus
 *
 * Handles all event subscriptions from the AgentOrchestrator, serializes
 * per-thread message queues, and routes events to DB + WebSocket + event bus.
 */

import type { AgentOrchestrator } from '@funny/core/agents';
import type { WSEvent, ThreadStatus } from '@funny/shared';

import { log } from '../lib/logger.js';
import { metric, type startSpan } from '../lib/telemetry.js';
import type { AgentMessageHandler } from './agent-message-handler.js';
import type { AgentStateTracker } from './agent-state.js';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';
import { getServices } from './service-registry.js';
import { flushPendingMessageUpdates } from './team-client.js';
import { threadEventBus } from './thread-event-bus.js';
import { transitionStatus } from './thread-status-machine.js';

export class AgentEventRouter {
  /** Per-thread message queue to serialize async message handling. */
  private messageQueues = new Map<string, Promise<void>>();
  /** Interval that sweeps settled promises from messageQueues. */
  private messageQueueCleanupTimer!: ReturnType<typeof setInterval>;

  private runSpans = new Map<string, ReturnType<typeof startSpan>>();
  private endRunSpanFn:
    | ((threadId: string, status: 'ok' | 'error', errorMsg?: string) => void)
    | null = null;

  constructor(
    private orchestrator: AgentOrchestrator,
    private state: AgentStateTracker,
    private messageHandler: AgentMessageHandler,
    private threadManager: IThreadManager,
    private wsBroker: IWSBroker,
  ) {
    this.subscribeOrchestrator();
    this.subscribeEventBus();
    this.startQueueCleanup();
  }

  /** Wire up the shared run spans and endRunSpan callback from the lifecycle manager */
  setSpanContext(
    runSpans: Map<string, ReturnType<typeof startSpan>>,
    endRunSpan: (threadId: string, status: 'ok' | 'error', errorMsg?: string) => void,
  ): void {
    this.runSpans = runSpans;
    this.endRunSpanFn = endRunSpan;
  }

  // ── Orchestrator event subscriptions ───────────────────────────

  private subscribeOrchestrator(): void {
    this.orchestrator.on('agent:message', (threadId: string, msg: any) => {
      const prev = this.messageQueues.get(threadId) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          await this.messageHandler.handle(threadId, msg);
          metric('agent.messages', 1, { type: 'sum', attributes: { threadId } });
        })
        .catch((err) => {
          log.error('Unhandled error in agent:message handler', {
            namespace: 'agent',
            threadId,
            error: (err as Error).message,
          });
        });
      this.messageQueues.set(threadId, next);
    });

    this.orchestrator.on('agent:error', (threadId: string, err: Error) => {
      void this.handleAgentFailure(threadId, err.message).catch((innerErr) => {
        log.error('Unhandled error in agent:error handler', {
          namespace: 'agent',
          threadId,
          error: (innerErr as Error).message,
        });
      });
    });

    this.orchestrator.on('agent:unexpected-exit', (threadId: string) => {
      void this.handleAgentFailure(
        threadId,
        'Agent process exited unexpectedly without a result',
      ).catch((err) => {
        log.error('Unhandled error in agent:unexpected-exit handler', {
          namespace: 'agent',
          threadId,
          error: (err as Error).message,
        });
      });
    });

    this.orchestrator.on('agent:stopped', (threadId: string) => {
      void (async () => {
        log.info('Agent stopped', { namespace: 'agent', threadId });
        // Drain debounced update_message buffers so a user-initiated stop
        // doesn't drop the last 100ms of streamed text from the DB.
        flushPendingMessageUpdates();
        this.endRunSpanFn?.(threadId, 'ok');
        const thread = await this.threadManager.getThread(threadId);
        const userId = thread?.userId;
        const currentStatus = thread?.status ?? 'running';
        const { status } = transitionStatus(
          threadId,
          { type: 'STOP' },
          currentStatus as ThreadStatus,
        );
        await this.threadManager.updateThread(threadId, {
          status,
          completedAt: new Date().toISOString(),
        });
        this.emitWSToUser(threadId, userId, 'agent:status', { status });
        if (thread) {
          await this.emitAgentCompleted(threadId, thread, 'stopped');
        }
      })().catch((err) => {
        log.error('Unhandled error in agent:stopped handler', {
          namespace: 'agent',
          threadId,
          error: (err as Error).message,
        });
      });
    });

    this.orchestrator.on('agent:session-cleared', (threadId: string) => {
      void (async () => {
        log.warn('Clearing stale sessionId after resume failure', { namespace: 'agent', threadId });
        await this.threadManager.updateThread(threadId, {
          sessionId: null,
          contextRecoveryReason: 'stale-session',
        });
      })().catch((err) => {
        log.error('Unhandled error in agent:session-cleared handler', {
          namespace: 'agent',
          threadId,
          error: (err as Error).message,
        });
      });
    });
  }

  // ── Event bus subscription ─────────────────────────────────────

  private subscribeEventBus(): void {
    threadEventBus.on('agent:completed', (event) => {
      if (this.runSpans.has(event.threadId)) {
        const status = event.status === 'completed' ? 'ok' : 'error';
        this.endRunSpanFn?.(
          event.threadId,
          status,
          event.status !== 'completed' ? event.status : undefined,
        );
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────

  emitWSToUser(
    threadId: string,
    userId: string | undefined,
    type: WSEvent['type'],
    data: unknown,
  ): void {
    const event = { type, threadId, data } as WSEvent;
    if (userId) {
      this.wsBroker.emitToUser(userId, event);
    } else {
      this.wsBroker.emit(event);
    }
  }

  async emitAgentCompleted(
    threadId: string,
    thread: {
      projectId: string;
      userId: string;
      worktreePath?: string | null;
      cost?: number | null;
    },
    status: 'completed' | 'failed' | 'stopped',
  ): Promise<void> {
    // Idempotency: skip if the bus event was already emitted for this run.
    // Both the SDK result path (agent-message-handler) and the failure/stop
    // paths can resolve the same run if the process exits or is stopped
    // shortly after a normal completion — emitting twice would cause the
    // queue handler to dequeue the next follow-up message twice.
    if (this.state.completedEmitted.has(threadId)) {
      log.warn('Suppressing duplicate agent:completed emission', {
        namespace: 'agent',
        threadId,
        status,
      });
      metric('agent.completed_emit_suppressed', 1, { type: 'sum', attributes: { status } });
      return;
    }
    this.state.completedEmitted.add(threadId);

    const project = thread.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : undefined;
    threadEventBus.emit('agent:completed', {
      threadId,
      projectId: thread.projectId,
      userId: thread.userId,
      cwd: thread.worktreePath ?? project?.path ?? '',
      worktreePath: thread.worktreePath ?? null,
      status,
      cost: thread.cost ?? 0,
    });
  }

  private async handleAgentFailure(threadId: string, errorMessage: string): Promise<void> {
    log.error('Agent failure', { namespace: 'agent', threadId, error: errorMessage });
    // Flush debounced update_message buffers so partial assistant text
    // emitted before the failure still lands in the DB.
    flushPendingMessageUpdates();
    this.endRunSpanFn?.(threadId, 'error', errorMessage);
    const thread = await this.threadManager.getThread(threadId);
    const userId = thread?.userId;
    const currentStatus = thread?.status ?? 'running';
    const { status } = transitionStatus(
      threadId,
      { type: 'FAIL', error: errorMessage },
      currentStatus as ThreadStatus,
    );
    await this.threadManager.updateThread(threadId, {
      status,
      completedAt: new Date().toISOString(),
    });
    this.emitWSToUser(threadId, userId, 'agent:error', { error: errorMessage });
    this.emitWSToUser(threadId, userId, 'agent:status', { status });
    if (thread) {
      await this.emitAgentCompleted(threadId, thread, status as 'completed' | 'failed' | 'stopped');
    }
  }

  // ── Queue management ───────────────────────────────────────────

  private startQueueCleanup(): void {
    const settledThreads = new Set<string>();
    this.messageQueueCleanupTimer = setInterval(() => {
      for (const threadId of settledThreads) {
        const current = this.messageQueues.get(threadId);
        if (current === undefined) {
          settledThreads.delete(threadId);
          continue;
        }
        this.messageQueues.delete(threadId);
        settledThreads.delete(threadId);
      }
      for (const [threadId, promise] of this.messageQueues) {
        void promise.then(
          () => settledThreads.add(threadId),
          () => settledThreads.add(threadId),
        );
      }
    }, 5 * 60_000);
    if (this.messageQueueCleanupTimer.unref) this.messageQueueCleanupTimer.unref();
  }

  /** Clean up message queue for a thread */
  clearQueue(threadId: string): void {
    this.messageQueues.delete(threadId);
  }

  /** Clear all queues and stop the cleanup timer */
  destroy(): void {
    clearInterval(this.messageQueueCleanupTimer);
    this.messageQueues.clear();
  }
}
