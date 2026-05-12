/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: @funny/pipelines
 *
 * Pipeline-driven dispatcher for the orchestrator.
 *
 * Transport-agnostic. Each dispatch:
 *   1. Resolves a compiled pipeline definition by name via the injected
 *      `PipelineLoader`.
 *   2. Builds a per-thread `ActionProvider` from the injected factory.
 *   3. Runs the pipeline with an `AbortController` (cancellation) and a
 *      `ProgressReporter` that bumps `lastEventAt` on every step
 *      transition — the orchestrator's stall detector reads this value.
 *   4. Returns a `DispatchHandle` whose `finished` Promise resolves to
 *      a `DispatchOutcome`.
 *
 * Generic over the pipeline context type `C` so callers can plug in
 * their own context shape (the runtime uses `YamlPipelineContext`).
 */

import { runPipeline, type PipelineDefinition, type ProgressReporter } from '@funny/pipelines';
import { nanoid } from 'nanoid';

// ── Public types ──────────────────────────────────────────────

export type DispatchOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled' };

export interface DispatchHandle {
  pipelineRunId: string;
  /** Best-effort cancellation. Idempotent. */
  abort: () => void;
  /** Resolves once the pipeline reaches a terminal state. */
  finished: Promise<DispatchOutcome>;
  /** ms timestamp of the most recent engine state-change event. */
  lastEventAt: () => number;
}

export type DispatchResult =
  | { ok: true; handle: DispatchHandle }
  | { ok: false; error: { message: string } };

export interface DispatchInput {
  threadId: string;
  projectId: string;
  userId: string;
  /** Working directory the pipeline runs in (e.g. project or worktree path). */
  cwd: string;
  /** Bound to the pipeline's `inputs.prompt` slot. */
  prompt: string;
  /** Pipeline name to load. Defaults to `orchestrator-thread`. */
  pipelineName?: string;
}

export interface PipelineLoaderScope {
  projectId: string;
  userId: string;
  /** Working directory — used by loaders that read overrides from disk. */
  cwd: string;
}

export interface PipelineLoader<C> {
  load(name: string, scope: PipelineLoaderScope): Promise<PipelineDefinition<C> | null>;
}

/**
 * Per-dispatch context builder. Receives the dispatch input and the
 * progress reporter wired by the dispatcher; returns the full context
 * (provider, inputs, outputs, etc.) ready for `runPipeline`.
 */
export interface ContextBuilder<C> {
  build(input: DispatchInput, progress: ProgressReporter): C;
}

export interface DispatcherLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface OrchestratorPipelineDispatcherDeps<C> {
  pipelines: PipelineLoader<C>;
  contextBuilder: ContextBuilder<C>;
  log?: DispatcherLogger;
  /** Test seam — defaults to `nanoid`. */
  pipelineRunIdFactory?: () => string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

// ── Constants ─────────────────────────────────────────────────

const NS = 'orchestrator-pipeline-dispatcher';
const DEFAULT_PIPELINE = 'orchestrator-thread';

const NOOP_LOG: DispatcherLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Service ───────────────────────────────────────────────────

export class OrchestratorPipelineDispatcher<C> {
  private readonly pipelines: PipelineLoader<C>;
  private readonly contextBuilder: ContextBuilder<C>;
  private readonly log: DispatcherLogger;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly active = new Map<string, DispatchHandle>();

  constructor(deps: OrchestratorPipelineDispatcherDeps<C>) {
    this.pipelines = deps.pipelines;
    this.contextBuilder = deps.contextBuilder;
    this.log = deps.log ?? NOOP_LOG;
    this.idFactory = deps.pipelineRunIdFactory ?? (() => nanoid());
    this.now = deps.now ?? (() => Date.now());
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const pipelineName = input.pipelineName ?? DEFAULT_PIPELINE;

    const definition = await this.pipelines.load(pipelineName, {
      projectId: input.projectId,
      userId: input.userId,
      cwd: input.cwd,
    });
    if (!definition) {
      return { ok: false, error: { message: `pipeline "${pipelineName}" not found` } };
    }

    const pipelineRunId = this.idFactory();
    const controller = new AbortController();

    let lastEventAt = this.now();
    const touch = () => {
      lastEventAt = this.now();
    };

    const reporter: ProgressReporter = {
      onStepProgress: () => touch(),
      onPipelineEvent: () => touch(),
    };

    const ctx = this.contextBuilder.build(input, reporter);

    let resolveFinished!: (outcome: DispatchOutcome) => void;
    const finished = new Promise<DispatchOutcome>((resolve) => {
      resolveFinished = resolve;
    });

    let settled = false;
    const settle = (outcome: DispatchOutcome): void => {
      if (settled) return;
      settled = true;
      this.active.delete(pipelineRunId);
      resolveFinished(outcome);
    };

    const handle: DispatchHandle = {
      pipelineRunId,
      lastEventAt: () => lastEventAt,
      abort: () => {
        if (settled) return;
        controller.abort();
      },
      finished,
    };

    this.active.set(pipelineRunId, handle);

    this.log.info('Pipeline dispatch starting', {
      namespace: NS,
      pipelineName,
      pipelineRunId,
      threadId: input.threadId,
      userId: input.userId,
      projectId: input.projectId,
    });

    void runPipeline<C>(definition, ctx, {
      signal: controller.signal,
      onStateChange: () => touch(),
    })
      .then((result) => {
        if (result.outcome === 'completed') {
          settle({ kind: 'completed' });
        } else if (result.outcome === 'cancelled') {
          settle({ kind: 'cancelled' });
        } else {
          settle({ kind: 'failed', error: result.error ?? 'pipeline failed' });
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('Pipeline dispatch threw unexpectedly', {
          namespace: NS,
          pipelineRunId,
          threadId: input.threadId,
          error: message,
        });
        settle({ kind: 'failed', error: message });
      });

    return { ok: true, handle };
  }

  /** Look up an in-flight handle by id. Used by reconcile + tests. */
  getActive(pipelineRunId: string): DispatchHandle | null {
    return this.active.get(pipelineRunId) ?? null;
  }

  /** Snapshot of currently in-flight runs. */
  listActive(): DispatchHandle[] {
    return [...this.active.values()];
  }
}
