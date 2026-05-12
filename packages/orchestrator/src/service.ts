/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: OrchestratorRunRepository, ThreadQueryAdapter, Dispatcher
 *
 * Orchestrator brain. Owns the poll/reconcile loops, builds the inputs
 * for `planDispatch` (pure logic in @funny/core/orchestrator), and applies
 * the resulting plan against the injected repository + dispatcher.
 *
 * Transport-agnostic: with in-process adapters this runs inside the
 * server; with HTTP adapters this runs inside the standalone orchestrator
 * binary against `/api/orchestrator/system/*`.
 */

import {
  isStalled,
  nextRetryDelayMs,
  planDispatch,
  type RetryEntry,
  type RunRef,
} from '@funny/core/orchestrator';
import type { Thread } from '@funny/shared';
import type { OrchestratorRunRepository } from '@funny/shared/repositories';
import { nanoid } from 'nanoid';

// ── Public types ──────────────────────────────────────────────

export type DispatchOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled' };

export interface DispatchHandle {
  pipelineRunId: string;
  abort: () => void;
  /** Resolves once the dispatched run reaches a terminal state. */
  finished: Promise<DispatchOutcome>;
}

export interface DispatchError {
  message: string;
}

export type DispatchResult =
  | { ok: true; handle: DispatchHandle }
  | { ok: false; error: DispatchError };

export interface Dispatcher {
  dispatch(thread: Thread): Promise<DispatchResult>;
}

export interface ThreadQueryAdapter {
  listEligibleCandidates(): Promise<Thread[]>;
  listTerminalThreadIds(): Promise<Set<string>>;
  getThreadById(id: string): Promise<Thread | null>;
}

export interface OrchestratorEmitter {
  emitToUser(userId: string, type: string, data: Record<string, unknown>): void;
}

export interface OrchestratorLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface OrchestratorConfig {
  enabled: boolean;
  pollIntervalMs: number;
  reconcileIntervalMs: number;
  maxConcurrentGlobal: number;
  maxConcurrentPerUser: number;
  maxRetryBackoffMs: number;
  stallTimeoutMs: number;
}

export const defaultOrchestratorConfig: OrchestratorConfig = {
  enabled: false,
  pollIntervalMs: 5_000,
  reconcileIntervalMs: 30_000,
  maxConcurrentGlobal: 16,
  maxConcurrentPerUser: 4,
  maxRetryBackoffMs: 300_000,
  stallTimeoutMs: 1_800_000,
};

export interface TickSummary {
  tickId: string;
  candidatesCount: number;
  dispatchedCount: number;
  retryCount: number;
  stalledCount: number;
}

export interface OrchestratorServiceDeps {
  runRepo: OrchestratorRunRepository;
  threadQuery: ThreadQueryAdapter;
  dispatcher: Dispatcher;
  emitter: OrchestratorEmitter;
  config: OrchestratorConfig;
  log: OrchestratorLogger;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

// ── Service ───────────────────────────────────────────────────

const NS = 'orchestrator-service';

export class OrchestratorService {
  private readonly runRepo: OrchestratorRunRepository;
  private readonly threadQuery: ThreadQueryAdapter;
  private readonly dispatcher: Dispatcher;
  private readonly emitter: OrchestratorEmitter;
  private readonly config: OrchestratorConfig;
  private readonly log: OrchestratorLogger;
  private readonly now: () => number;

  private readonly inFlight = new Map<string, DispatchHandle>();
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: OrchestratorServiceDeps) {
    this.runRepo = deps.runRepo;
    this.threadQuery = deps.threadQuery;
    this.dispatcher = deps.dispatcher;
    this.emitter = deps.emitter;
    this.config = deps.config;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info('Orchestrator disabled by config — not starting', { namespace: NS });
      return;
    }
    if (this.running) return;
    this.running = true;
    this.scheduleNextTick();
    this.scheduleNextReconcile();
    this.log.info('Orchestrator started', {
      namespace: NS,
      pollIntervalMs: this.config.pollIntervalMs,
      reconcileIntervalMs: this.config.reconcileIntervalMs,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.log.info('Orchestrator stopped', { namespace: NS });
  }

  async refresh(): Promise<TickSummary> {
    return this.tick();
  }

  // ── Internal loop scaffolding ──────────────────────────────

  private scheduleNextTick(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      void this.safeTick().finally(() => this.scheduleNextTick());
    }, this.config.pollIntervalMs);
  }

  private scheduleNextReconcile(): void {
    if (!this.running) return;
    this.reconcileTimer = setTimeout(() => {
      void this.safeReconcile().finally(() => this.scheduleNextReconcile());
    }, this.config.reconcileIntervalMs);
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.log.error('Orchestrator tick failed', {
        namespace: NS,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async safeReconcile(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      this.log.error('Orchestrator reconcile failed', {
        namespace: NS,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Tick ──────────────────────────────────────────────────

  private async tick(): Promise<TickSummary> {
    const now = this.now();
    const tickId = nanoid();

    const [runs, candidates, terminalIds] = await Promise.all([
      this.runRepo.listActiveRuns(),
      this.threadQuery.listEligibleCandidates(),
      this.threadQuery.listTerminalThreadIds(),
    ]);

    const dependencies = await this.runRepo.listDependenciesFor(candidates.map((c) => c.id));

    const running = new Map<string, RunRef>();
    const retryQueue = new Map<string, RetryEntry>();
    for (const r of runs) {
      if (r.nextRetryAtMs !== null) {
        retryQueue.set(r.threadId, {
          threadId: r.threadId,
          userId: r.userId,
          attempt: r.attempt,
          nextRetryAtMs: r.nextRetryAtMs,
          lastError: r.lastError ?? '',
        });
      } else {
        running.set(r.threadId, {
          threadId: r.threadId,
          userId: r.userId,
          attempt: r.attempt,
          lastEventAtMs: r.lastEventAtMs,
          pipelineRunId: r.pipelineRunId,
        });
      }
    }

    let stalledCount = 0;
    for (const ref of running.values()) {
      if (isStalled(ref, this.config.stallTimeoutMs, now)) {
        stalledCount++;
        this.handleStall(ref, now);
      }
    }

    const planResult = planDispatch({
      candidates,
      running,
      claimed: new Set(),
      retryQueue,
      dependencies,
      terminalThreadIds: terminalIds,
      slots: {
        maxConcurrentGlobal: this.config.maxConcurrentGlobal,
        maxConcurrentPerUser: this.config.maxConcurrentPerUser,
      },
      now,
    });

    if (planResult.isErr()) {
      this.log.error('Plan failed', { namespace: NS, error: planResult.error });
      return {
        tickId,
        candidatesCount: candidates.length,
        dispatchedCount: 0,
        retryCount: 0,
        stalledCount,
      };
    }

    const plan = planResult.value;

    for (const thread of plan.toDispatch) {
      await this.claimAndDispatch(thread, /* attempt */ 0);
    }
    for (const retry of plan.toRetry) {
      const thread = await this.threadQuery.getThreadById(retry.threadId);
      if (!thread) continue;
      await this.claimAndDispatch(thread, retry.attempt);
    }

    const summary: TickSummary = {
      tickId,
      candidatesCount: candidates.length,
      dispatchedCount: plan.toDispatch.length,
      retryCount: plan.toRetry.length,
      stalledCount,
    };
    this.emitter.emitToUser(
      '*',
      'orchestrator:tick',
      summary as unknown as Record<string, unknown>,
    );
    return summary;
  }

  private handleStall(ref: RunRef, now: number): void {
    const handle = this.inFlight.get(ref.threadId);
    if (handle) handle.abort();
    this.emitter.emitToUser(ref.userId, 'thread:stalled', {
      threadId: ref.threadId,
      lastEventAt: ref.lastEventAtMs,
      detectedAt: now,
    });
  }

  // ── Claim + dispatch ──────────────────────────────────────

  private async claimAndDispatch(thread: Thread, attempt: number): Promise<void> {
    const userId = thread.userId;
    const now = this.now();

    try {
      const existing = await this.runRepo.getRun(thread.id);
      if (!existing) {
        await this.runRepo.claim({ threadId: thread.id, userId, now });
      } else {
        await this.runRepo.setRetry({
          threadId: thread.id,
          attempt,
          nextRetryAtMs: now,
          lastError: existing.lastError ?? '',
        });
      }
      this.emitter.emitToUser(userId, 'thread:claimed', {
        threadId: thread.id,
        userId,
        attempt,
      });
    } catch (err) {
      this.log.warn('Claim race — skipping dispatch', {
        namespace: NS,
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let dispatchResult: DispatchResult;
    try {
      dispatchResult = await this.dispatcher.dispatch(thread);
    } catch (err) {
      dispatchResult = {
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }

    if (!dispatchResult.ok) {
      const next = nextRetryDelayMs(attempt + 1, this.config.maxRetryBackoffMs);
      await this.runRepo.setRetry({
        threadId: thread.id,
        attempt: attempt + 1,
        nextRetryAtMs: this.now() + next,
        lastError: dispatchResult.error.message,
      });
      this.emitter.emitToUser(userId, 'thread:retry-queued', {
        threadId: thread.id,
        attempt: attempt + 1,
        dueAtMs: this.now() + next,
        error: dispatchResult.error.message,
      });
      return;
    }

    const handle = dispatchResult.handle;
    await this.runRepo.setPipelineRunId(thread.id, handle.pipelineRunId);
    this.inFlight.set(thread.id, handle);

    this.emitter.emitToUser(userId, 'thread:dispatched', {
      threadId: thread.id,
      pipelineRunId: handle.pipelineRunId,
    });

    handle.finished
      .then((outcome) => this.onRunFinished(thread, attempt, outcome))
      .catch((err) => {
        this.log.error('Run finished promise rejected', {
          namespace: NS,
          threadId: thread.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async onRunFinished(
    thread: Thread,
    attempt: number,
    outcome: DispatchOutcome,
  ): Promise<void> {
    this.inFlight.delete(thread.id);
    const userId = thread.userId;
    if (outcome.kind === 'completed') {
      await this.runRepo.release(thread.id);
      this.emitter.emitToUser(userId, 'thread:released', {
        threadId: thread.id,
        terminalStatus: 'completed',
      });
      return;
    }
    const error = outcome.kind === 'failed' ? outcome.error : 'cancelled';
    const next = nextRetryDelayMs(attempt + 1, this.config.maxRetryBackoffMs);
    await this.runRepo.setRetry({
      threadId: thread.id,
      attempt: attempt + 1,
      nextRetryAtMs: this.now() + next,
      lastError: error,
    });
    this.emitter.emitToUser(userId, 'thread:retry-queued', {
      threadId: thread.id,
      attempt: attempt + 1,
      dueAtMs: this.now() + next,
      error,
    });
  }

  // ── Reconcile ─────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    const now = this.now();
    const [runs, terminalIds] = await Promise.all([
      this.runRepo.listActiveRuns(),
      this.threadQuery.listTerminalThreadIds(),
    ]);

    for (const run of runs) {
      if (terminalIds.has(run.threadId)) {
        const handle = this.inFlight.get(run.threadId);
        if (handle) {
          handle.abort();
          this.inFlight.delete(run.threadId);
        }
        await this.runRepo.release(run.threadId);
        continue;
      }

      const ref: RunRef = {
        threadId: run.threadId,
        userId: run.userId,
        attempt: run.attempt,
        lastEventAtMs: run.lastEventAtMs,
        pipelineRunId: run.pipelineRunId,
      };
      if (
        run.nextRetryAtMs === null &&
        !this.inFlight.has(run.threadId) &&
        isStalled(ref, this.config.stallTimeoutMs, now)
      ) {
        const next = nextRetryDelayMs(run.attempt + 1, this.config.maxRetryBackoffMs);
        await this.runRepo.setRetry({
          threadId: run.threadId,
          attempt: run.attempt + 1,
          nextRetryAtMs: now + next,
          lastError: 'orphaned-after-restart',
        });
        this.emitter.emitToUser(run.userId, 'thread:retry-queued', {
          threadId: run.threadId,
          attempt: run.attempt + 1,
          dueAtMs: now + next,
          error: 'orphaned-after-restart',
        });
      }
    }
  }
}
