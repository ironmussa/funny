/**
 * The ready-queue scheduler behind `runPipeline`.
 *
 * Every pipeline is a graph. Each node has a state (`pending`, `running`,
 * `succeeded`, `failed`, `skipped`, `cancelled`), and the scheduler starts
 * every pending node whose dependencies have finished, in declaration order,
 * up to `maxConcurrency` at a time. A slow branch therefore never holds an
 * unrelated one, unlike the level-by-level mode this replaces.
 *
 * - **Implicit chain.** When no node declares `dependsOn`, each node depends
 *   on the previous one, so a plain list runs in declaration order.
 * - **Context.** A node reads the context its dependencies produced: a root
 *   reads the initial context, a node with one dependency reads that
 *   dependency's result, and a node with several reads `mergeContexts` of
 *   them in declaration order. Finish order never changes what a node reads.
 * - **Loop region.** `loop` repeats the nodes on a path from `loop.from` to
 *   the last declared node. When that node succeeds and `until` is false, the
 *   region's nodes go back to `pending` and `loop.from` reads the last node's
 *   result. A node outside the region that depends on a node inside it waits
 *   until the loop exits.
 * - **Cancellation.** Each node execution has its own `AbortSignal`, linked to
 *   the run's signal; aborting the run aborts every running node, and the
 *   scheduler waits for them to settle before it reports `cancelled`.
 * - **Failure.** A node failure stops new nodes from starting; the scheduler
 *   waits for the running ones to settle and reports the failure.
 */

import { Effect, Exit } from 'effect';

import {
  SUB_PIPELINE_PARENT_CB,
  computeLevels,
  type GuardFn,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineOutcome,
  type PipelineRunOptions,
  type PipelineRunResult,
  type PipelineStateChange,
} from './engine.js';
import { causeMessage, invoke, runSingleNode } from './node-runner.js';

type NodeState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

interface GraphNode<T> {
  readonly def: PipelineNode<T>;
  /** Declaration index, used to keep starts and merges deterministic. */
  readonly index: number;
  readonly deps: GraphNode<T>[];
  readonly dependents: GraphNode<T>[];
  state: NodeState;
  /** The context the node produced (its input when it was skipped). */
  out?: T;
  /** The innermost loop region the node belongs to. */
  region?: Region<T>;
}

interface Region<T> {
  readonly entry: GraphNode<T>;
  readonly exit: GraphNode<T>;
  readonly members: ReadonlySet<GraphNode<T>>;
  readonly until: GuardFn<T>;
  readonly maxIterations: number;
  /** The current visit, from 1. */
  visit: number;
  /** True once the loop has exited; nodes outside it may then read its members. */
  closed: boolean;
  /** The exit node's result from the previous visit, read by the entry node. */
  feedback?: T;
}

/** What one node task reports back to the scheduler. */
type TaskResult<T> =
  | { kind: 'succeeded'; ctx: T; loop?: 'exit' | 'again' }
  | { kind: 'skipped'; ctx: T }
  | { kind: 'failed'; ctx: T; error: string }
  | { kind: 'cancelled'; ctx?: T };

interface Built<T> {
  nodes: GraphNode<T>[];
  region?: Region<T>;
}

/** Build the graph, refusing cycles, unknown dependencies and loops that are not regions. */
function buildGraph<T>(pipeline: PipelineDefinition<T>, maxIterations?: number): Built<T> {
  const defs = pipeline.nodes;
  const implicitChain = !defs.some((n) => n.dependsOn !== undefined);
  const depNames = (n: PipelineNode<T>, i: number): string[] =>
    implicitChain ? (i === 0 ? [] : [defs[i - 1].name]) : (n.dependsOn ?? []);

  // Cycles and unknown dependencies throw here with the same messages as before.
  computeLevels(defs.map((n, i) => ({ ...n, dependsOn: depNames(n, i) })));

  const nodes: GraphNode<T>[] = defs.map((def, index) => ({
    def,
    index,
    deps: [],
    dependents: [],
    state: 'pending',
  }));
  const byName = new Map(nodes.map((n) => [n.def.name, n]));
  for (const [i, node] of nodes.entries()) {
    for (const name of depNames(node.def, i)) {
      const dep = byName.get(name)!;
      node.deps.push(dep);
      dep.dependents.push(node);
    }
  }

  const loop = pipeline.loop;
  if (!loop || nodes.length === 0) return { nodes };
  const entry = byName.get(loop.from);
  if (!entry) throw new Error(`loop.from "${loop.from}" does not match any node name`);
  const exit = nodes[nodes.length - 1];
  const members = regionBetween(entry, exit);
  if (!members) {
    throw new Error(
      `loop.from "${loop.from}" is not "${exit.def.name}" or one of its dependencies, so the loop has no region`,
    );
  }
  const region: Region<T> = {
    entry,
    exit,
    members,
    until: loop.until,
    maxIterations: maxIterations ?? loop.maxIterations ?? 10,
    visit: 1,
    closed: false,
  };
  for (const m of members) m.region = region;
  return { nodes, region };
}

/** Every node on a path from `entry` to `exit`, both included, or null when there is none. */
function regionBetween<T>(entry: GraphNode<T>, exit: GraphNode<T>): Set<GraphNode<T>> | null {
  const ancestorsOfExit = new Set<GraphNode<T>>();
  const up = [exit];
  while (up.length > 0) {
    const n = up.pop()!;
    if (ancestorsOfExit.has(n)) continue;
    ancestorsOfExit.add(n);
    up.push(...n.deps);
  }
  if (!ancestorsOfExit.has(entry)) return null;
  const members = new Set<GraphNode<T>>();
  const down = [entry];
  while (down.length > 0) {
    const n = down.pop()!;
    if (members.has(n) || !ancestorsOfExit.has(n)) continue;
    members.add(n);
    down.push(...n.dependents);
  }
  return members;
}

const finished = (s: NodeState) => s === 'succeeded' || s === 'skipped' || s === 'failed';

/** Default merge: fold each result's `outputs` map over the base, in order. */
function defaultMerge<T>(base: T, results: T[]): T {
  const baseOutputs = (base as Record<string, unknown>).outputs;
  if (baseOutputs === undefined || typeof baseOutputs !== 'object') return base;
  const merged: Record<string, unknown> = { ...(baseOutputs as Record<string, unknown>) };
  for (const r of results) {
    const ro = (r as Record<string, unknown>).outputs;
    if (ro && typeof ro === 'object') Object.assign(merged, ro);
  }
  return { ...base, outputs: merged };
}

/** Run a pipeline as a graph. See the module comment for the rules. */
export async function runGraph<T>(
  pipeline: PipelineDefinition<T>,
  initialCtx: T,
  opts: PipelineRunOptions<T>,
): Promise<PipelineRunResult<T>> {
  const { signal, onStateChange } = opts;
  const emit = (change: PipelineStateChange<T>) => onStateChange?.(change);
  const merge = pipeline.mergeContexts ?? defaultMerge;
  const concurrency = Math.max(1, Math.floor(opts.maxConcurrency ?? 8));

  // Attach onStateChange to a copy of the context so sub-pipelines can
  // forward their events without mutating the caller's object.
  const initial = onStateChange
    ? ({ ...initialCtx, [SUB_PIPELINE_PARENT_CB]: onStateChange } as T)
    : initialCtx;

  let built: Built<T>;
  try {
    built = buildGraph(pipeline, opts.maxIterations);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit({
      kind: 'terminal',
      nodeName: pipeline.name,
      ctx: initial,
      iteration: 1,
      error,
      outcome: 'failed',
    });
    return { outcome: 'failed', ctx: initial, error, iterations: 1 };
  }
  const { nodes, region } = built;
  const iterations = () => region?.visit ?? 1;

  /** May `node` read `dep`'s result now? */
  const readable = (node: GraphNode<T>, dep: GraphNode<T>) =>
    finished(dep.state) && (!dep.region || dep.region.closed || dep.region === node.region);

  const inputOf = (node: GraphNode<T>): T => {
    if (region && node === region.entry && region.visit > 1) return region.feedback as T;
    if (node.deps.length === 0) return initial;
    if (node.deps.length === 1) return node.deps[0].out as T;
    const results = node.deps.map((d) => d.out as T);
    return merge(results[0], results);
  };

  /** The run's result context: the finished nodes no finished node has read yet. */
  const resultCtx = (): T => {
    const frontier = nodes.filter(
      (n) => finished(n.state) && !n.dependents.some((d) => finished(d.state)),
    );
    if (frontier.length === 0) return initial;
    if (frontier.length === 1) return frontier[0].out as T;
    const results = frontier.map((n) => n.out as T);
    return merge(results[0], results);
  };

  const running = new Map<GraphNode<T>, Promise<{ node: GraphNode<T>; result: TaskResult<T> }>>();
  let failure: { node: GraphNode<T>; error: string } | undefined;
  let lastRan: GraphNode<T> | undefined;

  const startTask = (node: GraphNode<T>) => {
    node.state = 'running';
    lastRan = node;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const iteration = node.region?.visit ?? 1;
    const task = runNodeTask(node, inputOf(node), {
      signal: controller.signal,
      emit,
      iteration,
      loopRegion: region && node === region.exit ? region : undefined,
    })
      .finally(() => signal?.removeEventListener('abort', abort))
      .then((result) => ({ node, result }));
    running.set(node, task);
  };

  const launchReady = () => {
    if (signal?.aborted || failure) return;
    for (const node of nodes) {
      if (running.size >= concurrency) return;
      if (node.state !== 'pending') continue;
      if (node.deps.every((d) => readable(node, d))) startTask(node);
    }
  };

  const apply = (node: GraphNode<T>, result: TaskResult<T>) => {
    switch (result.kind) {
      case 'cancelled':
        // A node that finished its work before the abort keeps its result.
        if (result.ctx !== undefined) {
          node.state = 'succeeded';
          node.out = result.ctx;
        } else {
          node.state = 'cancelled';
        }
        return;
      case 'failed':
        node.state = 'failed';
        node.out = result.ctx;
        failure ??= { node, error: result.error };
        return;
      case 'skipped':
        node.state = 'skipped';
        node.out = result.ctx;
        // A skipped exit node ends its loop, as the last node of a sequential loop did.
        if (region && node === region.exit) region.closed = true;
        return;
      case 'succeeded':
        node.state = 'succeeded';
        node.out = result.ctx;
        if (region && node === region.exit) {
          if (result.loop === 'again') {
            if (region.visit >= region.maxIterations) {
              failure ??= { node, error: `Max iterations reached (${region.maxIterations})` };
              return;
            }
            region.visit++;
            region.feedback = result.ctx;
            for (const m of region.members) {
              m.state = 'pending';
              m.out = undefined;
            }
          } else {
            region.closed = true;
          }
        }
    }
  };

  launchReady();
  while (running.size > 0) {
    const { node, result } = await Promise.race(running.values());
    running.delete(node);
    apply(node, result);
    launchReady();
  }

  const ctx = resultCtx();
  const terminal = (
    outcome: PipelineOutcome,
    nodeName: string,
    error?: string,
  ): PipelineRunResult<T> => {
    emit({ kind: 'terminal', nodeName, ctx, iteration: iterations(), outcome, error });
    const result: PipelineRunResult<T> = { outcome, ctx, iterations: iterations() };
    if (error !== undefined) result.error = error;
    return result;
  };

  if (signal?.aborted) return terminal('cancelled', lastRan?.def.name ?? pipeline.name);
  if (failure) return terminal('failed', failure.node.def.name, failure.error);
  const last = nodes[nodes.length - 1];
  return terminal('completed', last?.def.name ?? pipeline.name);
}

/** Run one node, then evaluate its loop condition when it closes a loop region. */
async function runNodeTask<T>(
  node: GraphNode<T>,
  input: T,
  params: {
    signal: AbortSignal;
    emit: (c: PipelineStateChange<T>) => void;
    iteration: number;
    loopRegion?: Region<T>;
  },
): Promise<TaskResult<T>> {
  const { signal, loopRegion } = params;
  const res = await runSingleNode(node.def, input, params);
  if (res.status === 'cancelled') {
    // A synchronous node can commit its result and abort the run in the same
    // call; keep that result (the node runner only adopts it in that case).
    return res.committed ? { kind: 'cancelled', ctx: res.ctx } : { kind: 'cancelled' };
  }
  if (res.status === 'error') return { kind: 'failed', ctx: res.ctx, error: res.error ?? 'failed' };
  if (res.status === 'skipped') return { kind: 'skipped', ctx: res.ctx };
  if (!loopRegion) return { kind: 'succeeded', ctx: res.ctx };

  const condition = await Effect.runPromiseExit(
    invoke(() => loopRegion.until(res.ctx)),
    { signal },
  );
  if (signal.aborted) return { kind: 'cancelled', ctx: res.ctx };
  if (Exit.isFailure(condition)) {
    return { kind: 'failed', ctx: res.ctx, error: causeMessage(condition.cause) };
  }
  return { kind: 'succeeded', ctx: res.ctx, loop: condition.value ? 'exit' : 'again' };
}
