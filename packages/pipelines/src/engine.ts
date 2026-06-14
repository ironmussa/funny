/**
 * Lightweight, function-based pipeline engine.
 *
 * Pipelines are sequences of named nodes. Each node is an async function
 * that receives context + AbortSignal and returns updated context.
 * Nodes can be conditionally skipped via guards.
 * A single optional loop boundary allows review→fix cycles.
 *
 * Zero dependencies — works in both server and client.
 */

// ── Types ────────────────────────────────────────────────────

/** A node function: receives context and signal, returns updated context. */
export type NodeFn<T> = (ctx: T, signal: AbortSignal) => T | Promise<T>;

/**
 * A guard function: returns true to run the node, false to skip.
 *
 * May return a Promise — useful when the predicate is backed by an async
 * expression engine (e.g. JSONata). The engine awaits the result.
 */
export type GuardFn<T> = (ctx: T) => boolean | Promise<boolean>;

/**
 * Per-node retry configuration. When a node throws, the engine will retry
 * it up to `maxAttempts` times, optionally invoking `beforeRetry` to
 * mutate context (e.g. spawn a fixer agent) and/or sleep `delayMs` between
 * attempts. Cancellation via AbortSignal short-circuits the retry loop.
 */
export interface NodeRetryConfig<T> {
  /**
   * Total max attempts (including the initial try). May be a number or a
   * function of context to allow ctx-driven configuration without losing
   * type safety.
   * Default behavior (no `retry`): a single attempt, identical to pre-retry
   * engine semantics.
   */
  maxAttempts: number | ((ctx: T) => number);
  /** Optional delay (ms) between attempts. Default: 0. */
  delayMs?: number | ((ctx: T) => number);
  /**
   * Optional predicate: only retry if it returns true. Useful to bail out
   * on permanent errors (e.g. auth failures) while retrying transient ones.
   * May return a Promise. Default: always retry until `maxAttempts` is reached.
   */
  shouldRetry?: (err: Error, ctx: T, attempt: number) => boolean | Promise<boolean>;
  /**
   * Hook invoked between attempts (after a failed attempt, before the next).
   * Receives the error, the context as it was when the node started, and
   * the attempt number that just failed. Return value becomes the context
   * for the next attempt — use this to spawn a fixer agent, log, or reset
   * state. Throwing here aborts the retry loop and fails the pipeline.
   */
  beforeRetry?: (err: Error, ctx: T, attempt: number) => T | Promise<T>;
}

/** A single pipeline node. */
export interface PipelineNode<T> {
  name: string;
  execute: NodeFn<T>;
  /** If provided and returns false, the node is skipped. */
  when?: GuardFn<T>;
  /** Optional retry configuration. If absent, the node runs exactly once. */
  retry?: NodeRetryConfig<T>;
  /**
   * IDs of nodes that must complete before this one starts (DAG edges).
   *
   * Presence of this field on ANY node switches the engine into DAG mode
   * (level-by-level parallel execution); absence everywhere preserves the
   * legacy sequential behavior. A node with `dependsOn: []` is a root and
   * runs in the first level. See `runPipeline` for the routing rule.
   */
  dependsOn?: string[];
}

/** Loop configuration — allows jumping back to a previous node. */
export interface PipelineLoop<T> {
  /** Name of the node to jump back to. */
  from: string;
  /** Return true to exit the loop, false to continue iterating. */
  until: GuardFn<T>;
  /** Maximum iterations before the pipeline fails. Default: 10. */
  maxIterations?: number;
}

/** A complete pipeline definition. */
export interface PipelineDefinition<T> {
  name: string;
  nodes: PipelineNode<T>[];
  loop?: PipelineLoop<T>;
  /**
   * How to fold the results of nodes that ran concurrently within one DAG
   * level back into a single context. Receives the shared `base` context the
   * level started from and the post-execute contexts of every node that
   * completed in that level (in declaration order, regardless of which
   * finished first — keeping the merge deterministic).
   *
   * Only consulted in DAG mode. If omitted, a default merge folds each
   * result's `outputs` map over the base (the convention used by the YAML
   * compiler, where every node writes only its own `outputs[id]`).
   */
  mergeContexts?: (base: T, results: T[]) => T;
}

/** State change notification types. */
export type PipelineStateKind = 'entering' | 'completed' | 'skipped' | 'error' | 'terminal';

/** Emitted when a node changes state. */
export interface PipelineStateChange<T> {
  kind: PipelineStateKind;
  nodeName: string;
  ctx: T;
  iteration: number;
  error?: string;
  /** For 'terminal': final outcome. */
  outcome?: PipelineOutcome;
}

/** Callback for state changes. */
export type OnStateChange<T> = (change: PipelineStateChange<T>) => void;

/** Options for runPipeline. */
export interface PipelineRunOptions<T> {
  signal?: AbortSignal;
  onStateChange?: OnStateChange<T>;
  /** Override maxIterations from the loop config. */
  maxIterations?: number;
  /**
   * Max nodes to run concurrently within a single DAG level. Ignored in
   * sequential mode. Default: 8.
   */
  maxConcurrency?: number;
}

/** Pipeline run outcome. */
export type PipelineOutcome = 'completed' | 'failed' | 'cancelled';

/** Result returned by runPipeline. */
export interface PipelineRunResult<T> {
  outcome: PipelineOutcome;
  ctx: T;
  error?: string;
  /** How many loop iterations completed. */
  iterations: number;
}

// ── Builder helpers ──────────────────────────────────────────

/** Create a pipeline node. */
export function node<T>(
  name: string,
  execute: NodeFn<T>,
  opts?: { when?: GuardFn<T>; retry?: NodeRetryConfig<T>; dependsOn?: string[] },
): PipelineNode<T> {
  return { name, execute, when: opts?.when, retry: opts?.retry, dependsOn: opts?.dependsOn };
}

/**
 * Embed an entire pipeline as a single node in a parent pipeline.
 * The sub-pipeline runs inline (same context, same signal) with its own
 * loop and maxIterations. State changes are forwarded to the parent's
 * onStateChange callback with prefixed node names: "parentName.childName".
 */
export function subPipeline<T>(
  name: string,
  pipeline: PipelineDefinition<T>,
  opts?: { when?: GuardFn<T>; maxIterations?: number },
): PipelineNode<T> {
  const execute: NodeFn<T> = async (ctx, signal) => {
    // Run the sub-pipeline inline. We pass a custom onStateChange that
    // is picked up by the runtime via a symbol on the context.
    const result = await runPipeline(pipeline, ctx, {
      signal,
      maxIterations: opts?.maxIterations ?? pipeline.loop?.maxIterations,
      // The parent runtime's onStateChange is forwarded via the _subPipelineParent symbol.
      // We prefix node names so the parent can distinguish sub-pipeline nodes.
      onStateChange: (change) => {
        // Forward to parent's onStateChange if available via the runtime context
        const parentCb = (ctx as any)?.[SUB_PIPELINE_PARENT_CB];
        if (parentCb) {
          parentCb({
            ...change,
            nodeName: `${name}.${change.nodeName}`,
          });
        }
      },
    });

    if (result.outcome === 'failed') {
      throw new Error(result.error ?? `Sub-pipeline "${pipeline.name}" failed`);
    }
    if (result.outcome === 'cancelled') {
      throw new Error('Pipeline cancelled');
    }
    return result.ctx;
  };

  return { name, execute, when: opts?.when };
}

/** Symbol used internally to pass parent onStateChange to sub-pipelines. */
export const SUB_PIPELINE_PARENT_CB = Symbol.for('pipeline:parentStateChange');

/** Create a pipeline definition. */
export function definePipeline<T>(def: PipelineDefinition<T>): PipelineDefinition<T> {
  // Validate loop.from references an existing node
  if (def.loop) {
    const fromNode = def.nodes.find((n) => n.name === def.loop!.from);
    if (!fromNode) {
      throw new Error(
        `Pipeline "${def.name}": loop.from "${def.loop.from}" does not match any node name`,
      );
    }
  }
  return def;
}

/**
 * Compose multiple node arrays into a single flat node list.
 * Useful for building pipelines from reusable node groups.
 */
export function compose<T>(...groups: PipelineNode<T>[][]): PipelineNode<T>[] {
  return groups.flat();
}

// ── Runtime ──────────────────────────────────────────────────

/**
 * Execute a pipeline definition with the given initial context.
 *
 * The pipeline runs nodes sequentially. When all nodes complete and
 * a loop is defined, it checks loop.until(ctx). If false, it jumps
 * back to loop.from and increments the iteration counter.
 */
export async function runPipeline<T>(
  pipeline: PipelineDefinition<T>,
  initialCtx: T,
  opts: PipelineRunOptions<T> = {},
): Promise<PipelineRunResult<T>> {
  // DAG mode: any node declaring `dependsOn` opts the whole pipeline into
  // level-by-level parallel execution. Loops are not yet supported over a
  // DAG (Phase 3.1) — when a loop is present we fall back to the sequential
  // path below, which stays valid because the YAML compiler emits DAG
  // pipelines already topologically sorted.
  if (!pipeline.loop && pipeline.nodes.some((n) => n.dependsOn !== undefined)) {
    return runDag(pipeline, initialCtx, opts);
  }

  const { signal, onStateChange } = opts;
  const maxIter = opts.maxIterations ?? pipeline.loop?.maxIterations ?? 10;

  let ctx = initialCtx;
  let iteration = 1;

  const emit = (change: PipelineStateChange<T>) => onStateChange?.(change);

  // Attach onStateChange to context so sub-pipelines can forward events.
  // Use a shallow copy to avoid mutating the caller's context (which would
  // cause infinite recursion when a subPipeline's onStateChange overwrites
  // the parent's callback on the same object).
  if (onStateChange) {
    ctx = { ...ctx, [SUB_PIPELINE_PARENT_CB]: onStateChange } as T;
  }

  // Resolve loop start index
  const loopFromIndex = pipeline.loop
    ? pipeline.nodes.findIndex((n) => n.name === pipeline.loop!.from)
    : -1;

  // Start from the first node
  let nodeIndex = 0;

  while (nodeIndex < pipeline.nodes.length) {
    const currentNode = pipeline.nodes[nodeIndex];

    // Check cancellation
    if (signal?.aborted) {
      emit({ kind: 'terminal', nodeName: currentNode.name, ctx, iteration, outcome: 'cancelled' });
      return { outcome: 'cancelled', ctx, iterations: iteration };
    }

    // Guard + retry + emits are shared with the DAG path via runSingleNode.
    const res = await runSingleNode(currentNode, ctx, { signal, emit, iteration });
    ctx = res.ctx;

    if (res.status === 'skipped') {
      nodeIndex++;
      continue;
    }

    if (res.status === 'error') {
      emit({
        kind: 'terminal',
        nodeName: currentNode.name,
        ctx,
        iteration,
        error: res.error,
        outcome: 'failed',
      });
      return { outcome: 'failed', ctx, error: res.error, iterations: iteration };
    }

    nodeIndex++;

    // Check for loop boundary — after the last node
    if (nodeIndex >= pipeline.nodes.length && pipeline.loop && loopFromIndex >= 0) {
      const exit = await pipeline.loop.until(ctx);
      if (!exit) {
        iteration++;
        if (iteration > maxIter) {
          const errorMsg = `Max iterations reached (${maxIter})`;
          emit({
            kind: 'terminal',
            nodeName: currentNode.name,
            ctx,
            iteration: iteration - 1,
            error: errorMsg,
            outcome: 'failed',
          });
          return { outcome: 'failed', ctx, error: errorMsg, iterations: iteration - 1 };
        }
        // Jump back to loop start
        nodeIndex = loopFromIndex;
        continue;
      }
    }
  }

  // All nodes completed, loop exited (or no loop)
  const lastNode = pipeline.nodes[pipeline.nodes.length - 1];
  emit({
    kind: 'terminal',
    nodeName: lastNode?.name ?? pipeline.name,
    ctx,
    iteration,
    outcome: 'completed',
  });
  return { outcome: 'completed', ctx, iterations: iteration };
}

// ── Single-node execution (shared by sequential + DAG paths) ─

/** Outcome of running one node, before the caller decides pipeline flow. */
interface SingleNodeResult<T> {
  /** Context after the node ran (unchanged if skipped). */
  ctx: T;
  status: 'completed' | 'skipped' | 'error';
  /** Set when status === 'error'. */
  error?: string;
}

/**
 * Run a single node: evaluate its `when` guard, execute with retry, and emit
 * `entering` / `completed` / `skipped` / `error` state changes. Does NOT emit
 * `terminal` — that's the caller's job, since terminal outcome depends on
 * pipeline-level flow (sequential vs DAG level).
 *
 * Extracted verbatim from the original sequential loop so both execution
 * paths share identical retry / guard / emit semantics.
 */
async function runSingleNode<T>(
  node: PipelineNode<T>,
  ctxIn: T,
  params: { signal?: AbortSignal; emit: (c: PipelineStateChange<T>) => void; iteration: number },
): Promise<SingleNodeResult<T>> {
  const { signal, emit, iteration } = params;
  let ctx = ctxIn;

  // Check guard (may be async — await the result).
  if (node.when) {
    const allow = await node.when(ctx);
    if (!allow) {
      emit({ kind: 'skipped', nodeName: node.name, ctx, iteration });
      return { ctx, status: 'skipped' };
    }
  }

  // Execute node — with retry support. When `retry` is undefined, the loop
  // runs exactly once, preserving pre-retry semantics.
  emit({ kind: 'entering', nodeName: node.name, ctx, iteration });

  const retryCfg = node.retry;
  const maxAttempts = retryCfg
    ? Math.max(
        1,
        typeof retryCfg.maxAttempts === 'function'
          ? retryCfg.maxAttempts(ctx)
          : retryCfg.maxAttempts,
      )
    : 1;

  let attempt = 0;
  let lastError: Error | undefined;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      ctx = await node.execute(ctx, signal ?? new AbortController().signal);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Cancellation always short-circuits, even if more attempts remain.
      if (signal?.aborted) break;

      if (!retryCfg || attempt >= maxAttempts) break;
      if (retryCfg.shouldRetry) {
        const allowRetry = await retryCfg.shouldRetry(lastError, ctx, attempt);
        if (!allowRetry) break;
      }

      if (retryCfg.beforeRetry) {
        try {
          ctx = await retryCfg.beforeRetry(lastError, ctx, attempt);
        } catch (hookErr) {
          // beforeRetry threw — abort retry loop with the hook's error.
          lastError = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
          break;
        }
      }

      const delay =
        typeof retryCfg.delayMs === 'function' ? retryCfg.delayMs(ctx) : (retryCfg.delayMs ?? 0);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  if (lastError) {
    const errorMsg = lastError.message;
    emit({ kind: 'error', nodeName: node.name, ctx, iteration, error: errorMsg });
    return { ctx, status: 'error', error: errorMsg };
  }

  emit({ kind: 'completed', nodeName: node.name, ctx, iteration });
  return { ctx, status: 'completed' };
}

// ── DAG execution (level-by-level parallel) ─────────────────

/**
 * Group nodes into topological levels: level(n) = 0 when it has no
 * dependencies, otherwise 1 + max(level of its deps). All nodes in the same
 * level are mutually independent and safe to run concurrently. Declaration
 * order is preserved within each level so merges stay deterministic.
 *
 * Throws on cycles or references to unknown nodes.
 */
export function computeLevels<T>(nodes: PipelineNode<T>[]): PipelineNode<T>[][] {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const levelOf = new Map<string, number>();

  const resolve = (name: string, path: string[]): number => {
    const cached = levelOf.get(name);
    if (cached !== undefined) return cached;
    if (path.includes(name)) {
      throw new Error(`Cycle detected: ${[...path, name].join(' → ')}`);
    }
    const n = byName.get(name);
    if (!n) throw new Error(`Node "${name}" referenced in dependsOn does not exist`);
    const deps = n.dependsOn ?? [];
    const level =
      deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => resolve(d, [...path, name])));
    levelOf.set(name, level);
    return level;
  };

  for (const n of nodes) resolve(n.name, []);

  const maxLevel = levelOf.size === 0 ? -1 : Math.max(...levelOf.values());
  const levels: PipelineNode<T>[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const n of nodes) levels[levelOf.get(n.name)!].push(n);
  return levels;
}

/** Bounded-concurrency runner: at most `limit` tasks in flight at once. */
function createPool(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active++;
        resolve();
      });
    });
  };
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return async function run<R>(fn: () => Promise<R>): Promise<R> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * Default level-merge: fold each result's `outputs` map over the base. Used
 * when a DAG pipeline doesn't supply its own `mergeContexts`. Matches the
 * convention that every node writes only its own `outputs[id]`, so the folds
 * never collide. Non-`outputs` fields are taken from the base.
 */
function defaultMerge<T>(base: T, results: T[]): T {
  const baseOutputs = (base as Record<string, unknown>).outputs;
  if (baseOutputs === undefined || typeof baseOutputs !== 'object') {
    // No `outputs` convention — nothing safe to merge; keep the base.
    return base;
  }
  const merged: Record<string, unknown> = { ...(baseOutputs as Record<string, unknown>) };
  for (const r of results) {
    const ro = (r as Record<string, unknown>).outputs;
    if (ro && typeof ro === 'object') Object.assign(merged, ro);
  }
  return { ...base, outputs: merged };
}

/**
 * Execute a pipeline as a DAG: nodes are grouped into topological levels and
 * each level runs concurrently (bounded by `maxConcurrency`). After a level
 * settles, the completed nodes' contexts are merged back into one. A node
 * failure fails the whole pipeline once its level settles (use the YAML
 * `on_error: continue` to tolerate a failure — that turns into an empty
 * output instead of a thrown error). Loops are not supported here.
 */
async function runDag<T>(
  pipeline: PipelineDefinition<T>,
  initialCtx: T,
  opts: PipelineRunOptions<T>,
): Promise<PipelineRunResult<T>> {
  const { signal, onStateChange } = opts;
  const emit = (change: PipelineStateChange<T>) => onStateChange?.(change);
  const merge = pipeline.mergeContexts ?? defaultMerge;
  const pool = createPool(Math.max(1, opts.maxConcurrency ?? 8));

  let ctx = initialCtx;
  if (onStateChange) {
    ctx = { ...ctx, [SUB_PIPELINE_PARENT_CB]: onStateChange } as T;
  }

  let levels: PipelineNode<T>[][];
  try {
    levels = computeLevels(pipeline.nodes);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    emit({
      kind: 'terminal',
      nodeName: pipeline.name,
      ctx,
      iteration: 1,
      error: errorMsg,
      outcome: 'failed',
    });
    return { outcome: 'failed', ctx, error: errorMsg, iterations: 1 };
  }

  for (const level of levels) {
    if (signal?.aborted) {
      emit({
        kind: 'terminal',
        nodeName: level[0]?.name ?? pipeline.name,
        ctx,
        iteration: 1,
        outcome: 'cancelled',
      });
      return { outcome: 'cancelled', ctx, iterations: 1 };
    }

    const base = ctx;
    const settled = await Promise.allSettled(
      level.map((n) => pool(() => runSingleNode(n, base, { signal, emit, iteration: 1 }))),
    );

    const completed: T[] = [];
    let firstError: { name: string; error: string } | undefined;
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        const r = s.value;
        if (r.status === 'error') {
          if (!firstError) firstError = { name: level[i].name, error: r.error ?? 'node failed' };
        } else if (r.status === 'completed') {
          completed.push(r.ctx);
        }
        // 'skipped' contributes no output.
      } else if (!firstError) {
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        firstError = { name: level[i].name, error: reason };
      }
    });

    // Fold whatever completed back in, even on failure, so the terminal
    // event carries partial outputs for debugging.
    ctx = merge(base, completed);

    if (firstError) {
      emit({
        kind: 'terminal',
        nodeName: firstError.name,
        ctx,
        iteration: 1,
        error: firstError.error,
        outcome: 'failed',
      });
      return { outcome: 'failed', ctx, error: firstError.error, iterations: 1 };
    }
  }

  const lastNode = pipeline.nodes[pipeline.nodes.length - 1];
  emit({
    kind: 'terminal',
    nodeName: lastNode?.name ?? pipeline.name,
    ctx,
    iteration: 1,
    outcome: 'completed',
  });
  return { outcome: 'completed', ctx, iterations: 1 };
}
