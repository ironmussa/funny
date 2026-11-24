/**
 * The ready-queue scheduler behind `runPipeline`. The graph and its rules
 * are in `graph.ts`, one node task in `node-task.ts`, the journal side in
 * `replay.ts`.
 *
 * Every pipeline is a graph. Each node has a state (`pending`, `running`,
 * `succeeded`, `failed`, `skipped`, `cancelled`), and the scheduler starts
 * every pending node whose dependencies have finished, in declaration order,
 * up to `maxConcurrency` at a time, so a slow branch never holds an
 * unrelated one.
 *
 * - **Implicit chain.** When no node declares `dependsOn`, each node depends
 *   on the previous one, so a plain list runs in declaration order.
 * - **Context.** A node reads the context its dependencies produced: a root
 *   reads the initial context, a node with one dependency reads that
 *   dependency's result, and a node with several reads `mergeContexts` of
 *   them in declaration order. Finish order never changes what a node reads.
 * - **Loop regions.** A node X with `loop` repeats the nodes on a path from
 *   `loop.backTo` to X (the pipeline-level `loop` is the same thing on the
 *   last declared node). When X succeeds and `until` is false, the region's
 *   nodes go back to `pending`, its visit number goes up, and `backTo` reads
 *   X's result. Loops nested inside it start over at visit 1. A node outside
 *   a region that depends on a node inside it waits until the loop exits.
 *   After `maxIterations` visits X fails with "loop exhausted". Regions must
 *   be nested or disjoint; overlapping ones are refused before any node runs.
 * - **Cancellation.** Each node execution has its own `AbortSignal`, linked to
 *   the run's signal; aborting the run aborts every running node, and the
 *   scheduler waits for them to settle before it reports `cancelled`.
 * - **Joins.** A node starts when its `triggerRule` (`all_success` by
 *   default, `all_done`, `one_success`) is satisfied, and is skipped once it
 *   can no longer be. A node skipped that way counts as failed for
 *   `all_success` dependents, so a failure skips everything downstream that
 *   needs it, while a node skipped by its `when` guard counts as done.
 * - **Concurrency groups.** A node with `concurrency` waits for a slot of its
 *   group from the run's `ConcurrencyGate` (shared across runs) after its
 *   guard passes, and gives it back once its work has stopped. In a
 *   batching group, a member's node takes the outcome its leader settled.
 * - **Journal.** With a `journal`, every execution is recorded, and a run
 *   that starts again replays what was recorded (see `journal.ts`).
 * - **Failure.** A node failure with `onError: 'fail'` (the default) stops
 *   new nodes from starting and aborts the nodes still running in other
 *   branches; the scheduler waits for them to stop (up to `stopGraceMs`
 *   each) and reports the first failure. Run cancellation does the same.
 *   With `onError: 'continue'` the node is marked failed and the joins decide.
 */

import type {
  PipelineDefinition,
  PipelineOutcome,
  PipelineRunOptions,
  PipelineRunResult,
  PipelineStateChange,
} from './engine.js';
import { defaultConcurrencyGate, type ConcurrencyGate, type SlotGrant } from './gate.js';
import {
  buildGraph,
  contains,
  finished,
  joinDecision,
  readable,
  visitPath,
  type Graph,
  type GraphNode,
  type Region,
} from './graph.js';
import { executionKey, latestByExecution, type JournalEntry } from './journal.js';
import type { TaskParams, TaskResult } from './node-task.js';
import { journaledNodeTask, replayNodeTask, replayOf } from './replay.js';
import { SUB_PIPELINE_PARENT_CB } from './symbols.js';

/** Narrows a value-or-resolver option to its resolver member. */
function isResolver<V>(value: V): value is Extract<V, (...args: never[]) => void> {
  return typeof value === 'function';
}

/** `typeof value === 'object'`: true for null as well. */
function isObjectOrNull(value: unknown): value is object | null {
  return typeof value === 'object';
}

/** Default merge: fold each result's `outputs` map over the base, in order. */
function defaultMerge<T>(base: T, results: T[]): T {
  const baseOutputs = (base as Record<string, unknown>).outputs;
  if (baseOutputs === undefined || !isObjectOrNull(baseOutputs)) return base;
  const merged: Record<string, unknown> = { ...(baseOutputs as Record<string, unknown>) };
  for (const r of results) {
    const ro = (r as Record<string, unknown>).outputs;
    if (ro && isObjectOrNull(ro)) Object.assign(merged, ro);
  }
  return { ...base, outputs: merged };
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Run a pipeline as a graph. See the module comment for the rules. */
export async function runGraph<T>(
  pipeline: PipelineDefinition<T>,
  initialCtx: T,
  opts: PipelineRunOptions<T>,
): Promise<PipelineRunResult<T>> {
  const onStateChange = opts.onStateChange;
  // Attach onStateChange to a copy of the context so sub-pipelines can
  // forward their events without mutating the caller's object.
  const initial = onStateChange
    ? ({ ...initialCtx, [SUB_PIPELINE_PARENT_CB]: onStateChange } as T)
    : initialCtx;
  const refuse = (error: string): PipelineRunResult<T> => {
    onStateChange?.({
      kind: 'terminal',
      nodeName: pipeline.name,
      ctx: initial,
      iteration: 1,
      error,
      outcome: 'failed',
    });
    return { outcome: 'failed', ctx: initial, error, iterations: 1 };
  };

  let graph: Graph<T>;
  let groups: Map<string, string>;
  try {
    graph = buildGraph(pipeline, opts.maxIterations);
    groups = groupsOf(pipeline, initialCtx);
  } catch (err) {
    return refuse(messageOf(err));
  }
  const runId = opts.runId ?? crypto.randomUUID();
  let recorded: Map<string, JournalEntry<T>>;
  try {
    recorded = latestByExecution((await opts.journal?.load(runId)) ?? []);
  } catch (err) {
    return refuse(`Could not load the run's journal: ${messageOf(err)}`);
  }
  return new GraphRun(pipeline, opts, { graph, groups, initial, runId, recorded }).run();
}

/** Each concurrency node's group, computed once from the initial context (never outputs). */
function groupsOf<T>(pipeline: PipelineDefinition<T>, initialCtx: T): Map<string, string> {
  const groups = new Map<string, string>();
  for (const n of pipeline.nodes) {
    const group = n.concurrency?.group;
    if (group !== undefined) groups.set(n.name, isResolver(group) ? group(initialCtx) : group);
  }
  return groups;
}

interface RunSetup<T> {
  graph: Graph<T>;
  groups: Map<string, string>;
  /** The initial context, as nodes read it. */
  initial: T;
  runId: string;
  /** The latest recorded attempt of each execution, by `executionKey`. */
  recorded: Map<string, JournalEntry<T>>;
}

type Settled<T> = { node: GraphNode<T>; result: TaskResult<T> };

/** One run of a graph: node states, running tasks, and how results move the run on. */
class GraphRun<T> {
  private readonly nodes: GraphNode<T>[];
  private readonly regions: Region<T>[];
  private readonly loopOf: Map<GraphNode<T>, Region<T>>;
  private readonly concurrency: number;
  private readonly gate: ConcurrencyGate;
  private readonly merge: (base: T, results: T[]) => T;
  private readonly running = new Map<GraphNode<T>, Promise<Settled<T>>>();
  /** Each running node's own abort, so a failure can stop its siblings. */
  private readonly controllers = new Map<GraphNode<T>, AbortController>();
  private failure: { node: GraphNode<T>; error: string } | undefined;
  private lastRan: GraphNode<T> | undefined;

  constructor(
    private readonly pipeline: PipelineDefinition<T>,
    private readonly opts: PipelineRunOptions<T>,
    private readonly setup: RunSetup<T>,
  ) {
    this.nodes = setup.graph.nodes;
    this.regions = setup.graph.regions;
    this.loopOf = new Map(this.regions.map((r) => [r.exit, r]));
    this.concurrency = Math.max(1, Math.floor(opts.maxConcurrency ?? 8));
    this.gate = opts.gate ?? defaultConcurrencyGate;
    this.merge = pipeline.mergeContexts ?? defaultMerge;
  }

  async run(): Promise<PipelineRunResult<T>> {
    this.launchReady();
    while (this.running.size > 0) {
      const { node, result } = await Promise.race(this.running.values());
      this.running.delete(node);
      this.controllers.delete(node);
      this.apply(node, result);
      this.launchReady();
    }
    return this.finish();
  }

  private emit(change: PipelineStateChange<T>) {
    this.opts.onStateChange?.(change);
  }

  private get aborted() {
    return this.opts.signal?.aborted === true;
  }

  // ── Starting nodes ────────────────────────────────────────

  private launchReady() {
    if (this.aborted || this.failure) return;
    // A skip can settle further joins, so sweep until nothing changes.
    while (this.sweep()) {
      // sweep again
    }
  }

  /** Start or skip every pending node whose join has decided; true if any was skipped. */
  private sweep(): boolean {
    let skipped = false;
    for (const node of this.nodes) {
      if (node.state !== 'pending') continue;
      const decision = joinDecision(node);
      if (decision === 'skip') {
        this.skipByJoin(node);
        skipped = true;
      } else if (decision === 'start' && this.running.size < this.concurrency) {
        this.startTask(node);
      }
    }
    return skipped;
  }

  /** The context `node` reads: its loop feedback, or what its finished dependencies produced. */
  private inputOf(node: GraphNode<T>): T {
    if (node.feedback !== undefined) {
      // The feedback already carries what the entry read on its first visit.
      node.readFrom = new Set(node.deps);
      return node.feedback;
    }
    // A join may start (or skip) before every dependency finished: read those that did.
    const read = node.deps.filter((d) => readable(node, d) && d.out !== undefined);
    node.readFrom = new Set(read);
    return this.fold(read.map((d) => d.out as T));
  }

  /** One context from several results, in declaration order. */
  private fold(results: T[]): T {
    if (results.length === 0) return this.setup.initial;
    if (results.length === 1) return results[0];
    return this.merge(results[0], results);
  }

  /** Skip `node` without running it, because its join can no longer be satisfied. */
  private skipByJoin(node: GraphNode<T>) {
    node.state = 'skipped';
    node.upstreamFailed = true;
    node.out = this.inputOf(node);
    const iteration = node.region?.visit ?? 1;
    this.emit({ kind: 'skipped', nodeName: node.def.name, ctx: node.out, iteration });
    this.closeLoopOf(node);
  }

  private startTask(node: GraphNode<T>) {
    node.state = 'running';
    this.lastRan = node;
    const controller = new AbortController();
    this.controllers.set(node, controller);
    const abort = () => controller.abort();
    const signal = this.opts.signal;
    signal?.addEventListener('abort', abort, { once: true });
    const visit = visitPath(node);
    const input = this.inputOf(node);
    const params: TaskParams<T> = {
      signal: controller.signal,
      emit: (c) => this.emit(c),
      iteration: node.region?.visit ?? 1,
      stopGraceMs: this.opts.stopGraceMs,
      acquireSlot: this.slotFor(node, visit, input),
      adoptBatchOutput: node.def.concurrency?.batch?.adopt,
      loopRegion: this.loopOf.get(node),
    };
    const task = this.taskFor(node, input, visit, params)
      .finally(() => signal?.removeEventListener('abort', abort))
      .then((result) => ({ node, result }));
    this.running.set(node, task);
  }

  /** Replay the recorded execution of `node`, or run it (resuming an unfinished one). */
  private taskFor(node: GraphNode<T>, input: T, visit: string, params: TaskParams<T>) {
    const { journal } = this.opts;
    const { runId, recorded } = this.setup;
    const previous = recorded.get(executionKey(node.def.name, visit));
    const replay = previous && replayOf(node, previous);
    if (replay) return replayNodeTask(node, replay, params);
    return journaledNodeTask({ journal, runId, node, visit, previous }, input, params);
  }

  /** How `node` asks for its concurrency slot, if it has a group. */
  private slotFor(node: GraphNode<T>, visit: string, input: T) {
    const concurrency = node.def.concurrency;
    const group = this.setup.groups.get(node.def.name);
    if (!concurrency || group === undefined) return undefined;
    const holder = `${this.setup.runId}/${node.def.name}/${visit}`;
    const { limit, batch } = concurrency;
    const policy = batch && { max: batch.max, waitMs: batch.waitMs };
    return (signal: AbortSignal, onWait: () => void): Promise<SlotGrant> =>
      this.gate.acquire({ group, limit, holder, signal, onWait, batch: policy, input });
  }

  // ── Results ───────────────────────────────────────────────

  private apply(node: GraphNode<T>, result: TaskResult<T>) {
    switch (result.kind) {
      case 'cancelled':
        // A node that finished its work before the abort keeps its result.
        node.state = result.ctx !== undefined ? 'succeeded' : 'cancelled';
        node.out = result.ctx;
        return;
      case 'failed':
        this.fail(node, result.ctx, result.error);
        return;
      case 'skipped':
        node.state = 'skipped';
        node.out = result.ctx;
        // A skipped loop node ends its loop, as the last node of a sequential loop did.
        this.closeLoopOf(node);
        return;
      case 'succeeded':
        this.succeeded(node, result);
    }
  }

  private succeeded(node: GraphNode<T>, result: Extract<TaskResult<T>, { kind: 'succeeded' }>) {
    const region = this.loopOf.get(node);
    if (!region || result.loop !== 'again') {
      node.state = 'succeeded';
      node.out = result.ctx;
      this.closeLoopOf(node);
      return;
    }
    if (region.visit < region.maxIterations) {
      this.loopAgain(region, result.ctx);
      return;
    }
    const error = `loop exhausted: "${node.def.name}" ran ${region.maxIterations} visits and its until condition never held`;
    this.emit({
      kind: 'error',
      nodeName: node.def.name,
      ctx: result.ctx,
      iteration: region.visit,
      error,
    });
    this.fail(node, result.ctx, error);
  }

  /** A node failed: fail the run, or with `onError: 'continue'` let the joins decide. */
  private fail(node: GraphNode<T>, ctx: T, error: string) {
    node.state = 'failed';
    node.out = ctx;
    if (node.def.onError === 'continue') {
      // A failed loop node ends its loop: there is no result to check.
      this.closeLoopOf(node);
      return;
    }
    this.failure ??= { node, error };
    // The run has failed: stop the nodes still running in other branches.
    for (const c of this.controllers.values()) c.abort();
  }

  /** Close the loop `node` declares, if any: nodes outside may now read its region. */
  private closeLoopOf(node: GraphNode<T>) {
    const r = this.loopOf.get(node);
    if (r) r.closed = true;
  }

  /** Send the run back through `region`: its nodes go back to pending. */
  private loopAgain(region: Region<T>, ctx: T) {
    region.visit++;
    for (const m of region.members) {
      m.state = 'pending';
      m.out = undefined;
      m.upstreamFailed = undefined;
      m.readFrom = undefined;
      m.feedback = undefined;
    }
    // Loops inside this one start over.
    for (const r of this.regions) {
      if (contains(region, r)) {
        r.visit = 1;
        r.closed = false;
      }
    }
    region.entry.feedback = ctx;
  }

  // ── The end ───────────────────────────────────────────────

  /** The run's result context: the finished nodes whose result no finished node read. */
  private resultCtx(): T {
    const readByFinished = (n: GraphNode<T>) =>
      n.dependents.some((d) => finished(d.state) && d.readFrom?.has(n) === true);
    const frontier = this.nodes.filter((n) => finished(n.state) && !readByFinished(n));
    return this.fold(frontier.map((n) => n.out as T));
  }

  private finish(): PipelineRunResult<T> {
    const ctx = this.resultCtx();
    const iterations = Math.max(1, ...this.regions.map((r) => r.visit));
    const terminal = (outcome: PipelineOutcome, nodeName: string, error?: string) => {
      this.emit({ kind: 'terminal', nodeName, ctx, iteration: iterations, outcome, error });
      const result: PipelineRunResult<T> = { outcome, ctx, iterations };
      if (error !== undefined) result.error = error;
      return result;
    };
    const name = this.pipeline.name;
    if (this.aborted) return terminal('cancelled', this.lastRan?.def.name ?? name);
    if (this.failure) return terminal('failed', this.failure.node.def.name, this.failure.error);
    return terminal('completed', this.nodes.at(-1)?.def.name ?? name);
  }
}
