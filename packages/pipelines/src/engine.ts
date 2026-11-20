/**
 * Lightweight, function-based pipeline engine.
 *
 * Pipelines are sequences of named nodes. Each node is an async function
 * that receives context + AbortSignal and returns updated context.
 * Nodes can be conditionally skipped via guards.
 * Nodes form a graph through `dependsOn` (a plain list is a chain), and a
 * loop repeats a region of it for review→fix cycles. The scheduler that
 * runs the graph is in `scheduler.ts`.
 *
 * Effect coordinates cancellation, retry waits, and node interruption.
 */

import { runGraph } from './scheduler.js';

// ── Types ────────────────────────────────────────────────────

/**
 * A node function: receives context and signal, returns updated context.
 * Async implementations must honor the signal and release owned resources on abort.
 * Effect can interrupt the wait, but cannot stop side effects in an uncooperative callback.
 */
export type NodeFn<T> = (ctx: T, signal: AbortSignal, info: NodeRunInfo) => T | Promise<T>;

/** What the engine tells a node about the execution it is running. */
export interface NodeRunInfo {
  /**
   * The visit of the innermost loop region the node belongs to, from 1
   * (always 1 outside loops). Hosts expose it to templates as `LOOP_ITERATION`.
   */
  iteration: number;
}

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
   * IDs of nodes that must finish before this one starts (graph edges).
   *
   * When no node declares it, each node depends on the previous one, so the
   * pipeline runs in declaration order. Once any node declares it, a node
   * without it (or with `dependsOn: []`) is a root and starts at once.
   */
  dependsOn?: string[];
  /**
   * How the node joins its dependencies. Default `all_success`.
   * - `all_success`: no dependency failed (a skipped dependency counts as done).
   * - `all_done`: every dependency finished, whatever its result.
   * - `one_success`: at least one dependency succeeded; the node starts on the
   *   first success without waiting for (or cancelling) the others.
   * A node whose rule can no longer be satisfied is skipped, and a node it
   * skips counts as failed for dependents with `all_success`.
   */
  triggerRule?: TriggerRule;
  /**
   * What a failure of this node does to the run. Default `fail`: the run
   * fails. `continue`: the node is marked failed and the joins decide.
   */
  onError?: NodeOnError;
  /**
   * Repeat a region after this node: every node on a path from `loop.backTo`
   * to this one. Checked after this node succeeds; see `NodeLoop`.
   */
  loop?: NodeLoop<T>;
}

/**
 * A loop declared on a node X. When X succeeds and `until` is false, the
 * region (the nodes on a path from `backTo` to X, both included) runs again,
 * and `backTo` reads X's result. Nodes outside the region that depend on it
 * wait until the loop exits. Once X has run `maxIterations` visits with
 * `until` still false, X fails with "loop exhausted" and its `onError`
 * applies. The regions of a pipeline must be nested or disjoint.
 */
export interface NodeLoop<T> {
  /** The first node of the region: X itself or one of its dependencies. */
  backTo: string;
  /** Return true to exit the loop. */
  until: GuardFn<T>;
  /** Visits before the loop is exhausted. Default: 10. */
  maxIterations?: number;
}

/** How a node joins its dependencies. See `PipelineNode.triggerRule`. */
export type TriggerRule = 'all_success' | 'all_done' | 'one_success';

/** What a node failure does to the run. See `PipelineNode.onError`. */
export type NodeOnError = 'fail' | 'continue';

/**
 * Pipeline-level loop: a region from `from` to the last declared node.
 * Equivalent to a `NodeLoop` on the last node; kept for existing callers.
 */
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
   * How to fold the results of several nodes into one context: for a node
   * with several dependencies, and for the run's result when it ends on
   * several branches. Receives the first result as `base` and every result
   * in declaration order, regardless of which finished first, so the merge
   * is deterministic.
   *
   * If omitted, a default merge folds each
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
  /** Override maxIterations of the pipeline-level `loop` (not of node loops). */
  maxIterations?: number;
  /**
   * Max nodes of this run in flight at once. Default: 8.
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
  opts?: Omit<PipelineNode<T>, 'name' | 'execute'>,
): PipelineNode<T> {
  return { ...opts, name, execute };
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
 * Every pipeline runs as a graph on a ready-queue scheduler
 * (`scheduler.ts`): a node starts as soon as its dependencies have
 * finished, bounded by `maxConcurrency`. When no node declares
 * `dependsOn`, each node depends on the previous one, so a plain list
 * runs in declaration order. A loop repeats its region (the nodes on a
 * path from `loop.from` to the last node) until `loop.until` holds.
 */
export function runPipeline<T>(
  pipeline: PipelineDefinition<T>,
  initialCtx: T,
  opts: PipelineRunOptions<T> = {},
): Promise<PipelineRunResult<T>> {
  return runGraph(pipeline, initialCtx, opts);
}

// ── Topological levels (graph validation) ───────────────────

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
