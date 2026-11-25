/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: @funny/pipelines
 *
 * Runs one YAML pipeline for one thread (the runtime's workflow runs).
 *
 * Transport-agnostic. Each dispatch:
 *   1. Resolves a compiled pipeline definition by name via the injected
 *      `PipelineLoader`.
 *   2. Builds a per-thread `ActionProvider` from the injected factory.
 *   3. Runs the pipeline with an `AbortController` (cancellation) and a
 *      `ProgressReporter` that bumps `lastEventAt` on every step
 *      transition.
 *   4. Returns a `DispatchHandle` whose `finished` Promise resolves to
 *      a `DispatchOutcome`.
 *
 * Generic over the pipeline context type `C` so callers can plug in
 * their own context shape (the runtime uses `YamlPipelineContext`).
 */

import { runPipeline, type PipelineDefinition, type ProgressReporter } from '@funny/pipelines';
import type { ParsedInputDef } from '@funny/workflows';
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
  /** Pipeline name to load. */
  pipelineName: string;
  /** Values supplied to the YAML pipeline's declared `inputs` contract. */
  inputs?: Record<string, unknown>;
}

export interface PipelineLoaderScope {
  projectId: string;
  userId: string;
  /** Working directory — used by loaders that read overrides from disk. */
  cwd: string;
}

export type PipelineInputDefinition = ParsedInputDef;

export interface PipelineLoadResult<C> {
  definition: PipelineDefinition<C>;
  inputs?: Record<string, PipelineInputDefinition>;
}

export interface PipelineLoader<C> {
  load(name: string, scope: PipelineLoaderScope): Promise<PipelineLoadResult<C> | null>;
}

export interface ContextBuildMeta {
  pipelineName: string;
  pipelineRunId: string;
}

/**
 * Per-dispatch context builder. Receives the dispatch input and the
 * progress reporter wired by the dispatcher; returns the full context
 * (provider, inputs, outputs, etc.) ready for `runPipeline`.
 */
export interface ContextBuilder<C> {
  build(input: DispatchInput, progress: ProgressReporter, meta?: ContextBuildMeta): C;
  /**
   * The reporter a built context reports its steps through. The dispatcher
   * reports there what the engine sees before a step runs (a node waiting for
   * its concurrency group's slot). Without it, only the dispatcher's own
   * reporter hears of it.
   */
  progressOf?(ctx: C): ProgressReporter;
}

export interface DispatcherLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface PipelineDispatcherDeps<C> {
  pipelines: PipelineLoader<C>;
  contextBuilder: ContextBuilder<C>;
  log?: DispatcherLogger;
  /** Test seam — defaults to `nanoid`. */
  pipelineRunIdFactory?: () => string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

// ── Constants ─────────────────────────────────────────────────

const NS = 'pipeline-dispatcher';

const NOOP_LOG: DispatcherLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SYSTEM_INPUT_KEYS = new Set(['threadId', 'projectId', 'userId', 'cwd', 'prompt']);

// ── Service ───────────────────────────────────────────────────

export class PipelineDispatcher<C> {
  private readonly pipelines: PipelineLoader<C>;
  private readonly contextBuilder: ContextBuilder<C>;
  private readonly log: DispatcherLogger;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly active = new Map<string, DispatchHandle>();

  constructor(deps: PipelineDispatcherDeps<C>) {
    this.pipelines = deps.pipelines;
    this.contextBuilder = deps.contextBuilder;
    this.log = deps.log ?? NOOP_LOG;
    this.idFactory = deps.pipelineRunIdFactory ?? (() => nanoid());
    this.now = deps.now ?? (() => Date.now());
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const { pipelineName } = input;

    const loaded = await this.pipelines.load(pipelineName, {
      projectId: input.projectId,
      userId: input.userId,
      cwd: input.cwd,
    });
    if (!loaded) {
      return { ok: false, error: { message: `pipeline "${pipelineName}" not found` } };
    }

    const resolvedInputs = resolvePipelineInputs({
      declared: loaded.inputs ?? {},
      supplied: input.inputs ?? {},
      system: systemInputs(input),
    });
    if (!resolvedInputs.ok) {
      return { ok: false, error: { message: resolvedInputs.error } };
    }

    const definition = loaded.definition;
    const dispatchInput: DispatchInput = { ...input, inputs: resolvedInputs.value };

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

    const ctx = this.contextBuilder.build(dispatchInput, reporter, {
      pipelineName,
      pipelineRunId,
    });

    this.log.info('Pipeline dispatch starting', {
      namespace: NS,
      pipelineName,
      pipelineRunId,
      threadId: input.threadId,
      userId: input.userId,
      projectId: input.projectId,
    });

    const stepReporter = this.contextBuilder.progressOf?.(ctx) ?? reporter;
    void runPipeline<C>(definition, ctx, {
      runId: pipelineRunId,
      signal: controller.signal,
      onStateChange: (change) => {
        touch();
        // A node waiting for a slot has not started its action, so nothing
        // else reports it.
        if (change.kind === 'waiting_slot') {
          stepReporter.onStepProgress(change.nodeName, {
            status: 'pending',
            metadata: { workflowStatus: 'waiting_slot' },
          });
        }
      },
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

function systemInputs(input: DispatchInput): Record<string, unknown> {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    userId: input.userId,
    cwd: input.cwd,
    prompt: input.prompt,
  };
}

function resolvePipelineInputs(args: {
  declared: Record<string, PipelineInputDefinition>;
  supplied: Record<string, unknown>;
  system: Record<string, unknown>;
}): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const errors: string[] = [];
  const declaredKeys = new Set(Object.keys(args.declared));

  for (const key of Object.keys(args.supplied)) {
    if (!declaredKeys.has(key) && !SYSTEM_INPUT_KEYS.has(key)) {
      errors.push(`unknown input "${key}"`);
    }
  }

  const value: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(args.declared)) {
    if (def.default !== undefined) value[key] = def.default;
  }
  Object.assign(value, args.supplied, args.system);

  for (const [key, def] of Object.entries(args.declared)) {
    const current = value[key];
    if (current === undefined) {
      if (def.required) errors.push(`missing required input "${key}"`);
      continue;
    }
    if (!matchesInputType(current, def.type)) {
      errors.push(`input "${key}" must be ${def.type}`);
    }
  }

  return errors.length > 0
    ? { ok: false, error: `Invalid pipeline inputs: ${errors.join('; ')}` }
    : { ok: true, value };
}

/** A value of one of the declared pipeline input types (string, number, boolean, array, object). */
type PipelineInputValue = string | number | boolean | object;

function matchesInputType(
  value: unknown,
  type: PipelineInputDefinition['type'],
): value is PipelineInputValue {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  return false;
}
