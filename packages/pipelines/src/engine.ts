/**
 * Pipeline types and builders, and the `runPipeline` entry point.
 *
 * A pipeline is a graph of named nodes. Each node is a function that
 * receives the context, an AbortSignal and its run info, and returns the
 * updated context. Nodes form the graph through `dependsOn` (a plain list
 * is a chain), may be skipped by a `when` guard, join by `triggerRule`,
 * repeat a region with `loop`, and share limits across runs through
 * `concurrency`. The scheduler that runs the graph is in `scheduler.ts`.
 *
 * Effect coordinates cancellation, retry waits, and node interruption.
 */

import type { Batch, ConcurrencyGate } from './gate.js';
import type { Journal, ResumeInfo } from './journal.js';
import { runGraph } from './scheduler.js';
import { SUB_PIPELINE_PARENT_CB } from './symbols.js';
import type { NodeData } from './types.js';

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
  /**
   * The visits of every loop region around the node, outermost first, joined
   * by dots ("1" outside loops). Identifies this execution in the journal.
   */
  visit: string;
  /**
   * Set when the run resumes an execution that started but never finished:
   * what was recorded for it, including what it checkpointed, so the node can
   * adopt the work it had started.
   */
  resume?: ResumeInfo;
  /** Record data about the work in progress (e.g. the thread started) in the journal. */
  checkpoint(data: NodeData): Promise<void>;
  /**
   * Set when this node leads a batch: the other runs it executes for. Settle
   * each member before the node ends; members left unsettled wait again.
   */
  batch?: Batch;
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
  /**
   * Limit how many executions of nodes in `group` run at once, across every
   * run that shares the gate (`PipelineRunOptions.gate`). The node waits for
   * a slot after its `when` guard passes, reported as `waiting_slot`, and
   * holds it until its work has stopped (retries included).
   */
  concurrency?: NodeConcurrency<T>;
}

/** A node's concurrency group. See `PipelineNode.concurrency`. */
export interface NodeConcurrency<T> {
  /**
   * The group. A function receives the run's initial context, never node
   * outputs, so a resumed run asks for the same group.
   */
  group: string | ((initial: T) => string);
  /** Executions of the group allowed at once. The gate may replace it. */
  limit: number;
  /**
   * Run the node once for several runs waiting on the group (limit 1). The
   * leader's node gets `info.batch` and settles each member; a member's node
   * does not execute and completes with the outcome settled for it.
   */
  batch?: NodeBatch<T>;
}

/** A batching concurrency group. See `NodeConcurrency.batch`. */
export interface NodeBatch<T> {
  /** Most runs in one batch, the leader included. */
  max: number;
  /** How long the leader waits for more members before it starts. */
  waitMs: number;
  /**
   * A member's result context from the output its leader settled. Default:
   * the member's input, unchanged.
   */
  adopt?: (input: T, output: NodeData) => T;
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
export type PipelineStateKind =
  | 'waiting_slot'
  | 'entering'
  | 'completed'
  | 'skipped'
  | 'error'
  | 'terminal';

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
  /**
   * After a node is aborted (the run was cancelled, or another branch failed
   * it), how long to wait for its work to stop before the run ends anyway.
   * A node that honors its signal stops sooner. Default: 5000.
   */
  stopGraceMs?: number;
  /**
   * Grants concurrency-group slots. Default: one in-memory gate shared by
   * every run of the process (`defaultConcurrencyGate`).
   */
  gate?: ConcurrencyGate;
  /**
   * Records node executions, and replays the recorded ones when the run
   * starts (see `journal.ts`). Without one, nothing is recorded or resumed.
   */
  journal?: Journal<T>;
  /** Identifies the run in slot holders (`<runId>/<nodeId>/<visit>`). Default: a random id. */
  runId?: string;
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

/** A context that runGraph gave its parent run's onStateChange callback. */
type ParentCbCarrier<T> = { [SUB_PIPELINE_PARENT_CB]?: OnStateChange<T> };

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
        // SAFETY: runGraph is the only writer of SUB_PIPELINE_PARENT_CB on a context, and it
        // stores the parent run's onStateChange callback there.
        const parentCb = (ctx as ParentCbCarrier<T> | null | undefined)?.[SUB_PIPELINE_PARENT_CB];
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

export { SUB_PIPELINE_PARENT_CB } from './symbols.js';

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
