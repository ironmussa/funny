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
 *   guard passes, and gives it back once its work has stopped.
 * - **Failure.** A node failure with `onError: 'fail'` (the default) stops
 *   new nodes from starting and aborts the nodes still running in other
 *   branches; the scheduler waits for them to stop (up to `stopGraceMs`
 *   each) and reports the first failure. Run cancellation does the same. With `onError: 'continue'` the node is
 *   marked failed and the joins decide.
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
import { defaultConcurrencyGate } from './gate.js';
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
  /** Skipped because its join could no longer be satisfied (an upstream failure). */
  upstreamFailed?: boolean;
  /** The dependencies whose results this node read when it started (or was skipped). */
  readFrom?: ReadonlySet<GraphNode<T>>;
  /** The innermost loop region the node belongs to. */
  region?: Region<T>;
  /** Set when a loop sent the run back to this node: what it reads on that visit. */
  feedback?: T;
}

interface Region<T> {
  readonly entry: GraphNode<T>;
  /** The node that declares the loop. */
  readonly exit: GraphNode<T>;
  readonly members: ReadonlySet<GraphNode<T>>;
  readonly until: GuardFn<T>;
  readonly maxIterations: number;
  /** The smallest region that strictly contains this one. */
  parent?: Region<T>;
  /** The current visit, from 1. */
  visit: number;
  /** True once the loop has exited; nodes outside it may then read its members. */
  closed: boolean;
}

/** A loop before its region is computed. */
interface LoopSpec<T> {
  exit: GraphNode<T>;
  backTo: string;
  until: GuardFn<T>;
  maxIterations: number;
}

/** What one node task reports back to the scheduler. */
type TaskResult<T> =
  | { kind: 'succeeded'; ctx: T; loop?: 'exit' | 'again' }
  | { kind: 'skipped'; ctx: T }
  | { kind: 'failed'; ctx: T; error: string }
  | { kind: 'cancelled'; ctx?: T };

interface Built<T> {
  nodes: GraphNode<T>[];
  regions: Region<T>[];
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

  const specs: LoopSpec<T>[] = [];
  for (const node of nodes) {
    const loop = node.def.loop;
    if (loop) {
      specs.push({
        exit: node,
        backTo: loop.backTo,
        until: loop.until,
        maxIterations: loop.maxIterations ?? 10,
      });
    }
  }
  const legacy = pipeline.loop;
  if (legacy && nodes.length > 0) {
    const exit = nodes[nodes.length - 1];
    if (exit.def.loop) {
      throw new Error(
        `"${exit.def.name}" declares a loop and is also the end of the pipeline loop`,
      );
    }
    specs.push({
      exit,
      backTo: legacy.from,
      until: legacy.until,
      maxIterations: maxIterations ?? legacy.maxIterations ?? 10,
    });
  }
  return { nodes, regions: buildRegions(specs, byName) };
}

/** Compute each loop's region, refuse overlaps, and link every node to its innermost region. */
function buildRegions<T>(specs: LoopSpec<T>[], byName: Map<string, GraphNode<T>>): Region<T>[] {
  const regions = specs.map((spec): Region<T> => {
    const name = spec.exit.def.name;
    const entry = byName.get(spec.backTo);
    if (!entry) {
      throw new Error(`The loop on "${name}" goes back to "${spec.backTo}", which is not a node`);
    }
    const members = regionBetween(entry, spec.exit);
    if (!members) {
      throw new Error(
        `The loop on "${name}" goes back to "${spec.backTo}", which is not "${name}" or one of its dependencies, so the loop has no region`,
      );
    }
    return {
      entry,
      exit: spec.exit,
      members,
      until: spec.until,
      maxIterations: Math.max(1, spec.maxIterations),
      visit: 1,
      closed: false,
    };
  });

  const contains = (outer: Region<T>, inner: Region<T>) =>
    outer.members.size > inner.members.size &&
    [...inner.members].every((m) => outer.members.has(m));
  for (const [i, a] of regions.entries()) {
    for (const b of regions.slice(i + 1)) {
      const shared = [...a.members].some((m) => b.members.has(m));
      if (shared && !contains(a, b) && !contains(b, a)) {
        throw new Error(
          `The loops on "${a.exit.def.name}" (back to "${a.entry.def.name}") and "${b.exit.def.name}" (back to "${b.entry.def.name}") overlap; loop regions must be nested or disjoint`,
        );
      }
    }
  }

  // Smallest first, so the first region found containing something is the innermost.
  const bySize = [...regions].sort((a, b) => a.members.size - b.members.size);
  for (const r of bySize) r.parent = bySize.find((o) => contains(o, r));
  for (const r of [...bySize].reverse()) for (const m of r.members) m.region = r;
  return regions;
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

  const gate = opts.gate ?? defaultConcurrencyGate;
  const runId = opts.runId ?? crypto.randomUUID();
  let built: Built<T>;
  /** Each concurrency node's group, computed once from the initial context. */
  const groups = new Map<string, string>();
  try {
    built = buildGraph(pipeline, opts.maxIterations);
    for (const n of pipeline.nodes) {
      const group = n.concurrency?.group;
      if (group !== undefined) {
        groups.set(n.name, typeof group === 'function' ? group(initialCtx) : group);
      }
    }
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
  const { nodes, regions } = built;
  const iterations = () => Math.max(1, ...regions.map((r) => r.visit));
  const loopOf = new Map(regions.map((r) => [r.exit, r]));

  /** `region` and every region around it. */
  const enclosing = (region: Region<T> | undefined): Region<T>[] => {
    const out: Region<T>[] = [];
    for (let r = region; r; r = r.parent) out.push(r);
    return out;
  };

  /** Close the loop `node` declares, if any: nodes outside may now read its region. */
  const closeLoopOf = (node: GraphNode<T>) => {
    const r = loopOf.get(node);
    if (r) r.closed = true;
  };

  /** Did `dep` fail, for a dependent's join (a node skipped by a failure counts)? */
  const failedForJoin = (dep: GraphNode<T>) =>
    dep.state === 'failed' || (dep.state === 'skipped' && dep.upstreamFailed === true);

  /** What `node`'s trigger rule says now: start it, skip it, or wait. */
  const joinDecision = (node: GraphNode<T>): 'start' | 'skip' | 'wait' => {
    const done = node.deps.filter((d) => readable(node, d));
    const allDone = done.length === node.deps.length;
    switch (node.def.triggerRule ?? 'all_success') {
      case 'all_done':
        return allDone ? 'start' : 'wait';
      case 'one_success':
        if (node.deps.length === 0) return 'start';
        if (done.some((d) => d.state === 'succeeded')) return 'start';
        return allDone ? 'skip' : 'wait';
      case 'all_success':
        if (done.some(failedForJoin)) return 'skip';
        return allDone ? 'start' : 'wait';
    }
  };

  /** May `node` read `dep`'s result now? Not while a loop around `dep` but not `node` is open. */
  const readable = (node: GraphNode<T>, dep: GraphNode<T>) =>
    finished(dep.state) && enclosing(dep.region).every((r) => r.closed || r.members.has(node));

  const inputOf = (node: GraphNode<T>): T => {
    if (node.feedback !== undefined) {
      // The feedback already carries what the entry read on its first visit.
      node.readFrom = new Set(node.deps);
      return node.feedback;
    }
    // A join may start (or skip) before every dependency finished: read those that did.
    const read = node.deps.filter((d) => readable(node, d) && d.out !== undefined);
    node.readFrom = new Set(read);
    const results = read.map((d) => d.out as T);
    if (results.length === 0) return initial;
    if (results.length === 1) return results[0];
    return merge(results[0], results);
  };

  /** Skip `node` without running it, because its join can no longer be satisfied. */
  const skipByJoin = (node: GraphNode<T>) => {
    node.state = 'skipped';
    node.upstreamFailed = true;
    node.out = inputOf(node);
    emit({
      kind: 'skipped',
      nodeName: node.def.name,
      ctx: node.out,
      iteration: node.region?.visit ?? 1,
    });
    closeLoopOf(node);
  };

  /** The run's result context: the finished nodes whose result no finished node read. */
  const resultCtx = (): T => {
    const frontier = nodes.filter(
      (n) =>
        finished(n.state) &&
        !n.dependents.some((d) => finished(d.state) && d.readFrom?.has(n) === true),
    );
    if (frontier.length === 0) return initial;
    if (frontier.length === 1) return frontier[0].out as T;
    const results = frontier.map((n) => n.out as T);
    return merge(results[0], results);
  };

  const running = new Map<GraphNode<T>, Promise<{ node: GraphNode<T>; result: TaskResult<T> }>>();
  /** Each running node's own abort, so a failure can stop its siblings. */
  const controllers = new Map<GraphNode<T>, AbortController>();
  let failure: { node: GraphNode<T>; error: string } | undefined;
  let lastRan: GraphNode<T> | undefined;

  /** How `node` asks for its concurrency slot, if it has a group. */
  const slotFor = (node: GraphNode<T>, visit: number) => {
    const concurrency = node.def.concurrency;
    const group = groups.get(node.def.name);
    if (!concurrency || group === undefined) return undefined;
    const holder = `${runId}/${node.def.name}/${visit}`;
    return (signal: AbortSignal, onWait: () => void) =>
      gate.acquire({ group, limit: concurrency.limit, holder, signal, onWait });
  };

  const startTask = (node: GraphNode<T>) => {
    node.state = 'running';
    lastRan = node;
    const controller = new AbortController();
    controllers.set(node, controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const iteration = node.region?.visit ?? 1;
    const task = runNodeTask(node, inputOf(node), {
      signal: controller.signal,
      emit,
      iteration,
      stopGraceMs: opts.stopGraceMs,
      acquireSlot: slotFor(node, iteration),
      loopRegion: loopOf.get(node),
    })
      .finally(() => signal?.removeEventListener('abort', abort))
      .then((result) => ({ node, result }));
    running.set(node, task);
  };

  const launchReady = () => {
    if (signal?.aborted || failure) return;
    // A skip can settle further joins, so sweep until nothing changes.
    for (let changed = true; changed;) {
      changed = false;
      for (const node of nodes) {
        if (node.state !== 'pending') continue;
        const decision = joinDecision(node);
        if (decision === 'skip') {
          skipByJoin(node);
          changed = true;
        } else if (decision === 'start' && running.size < concurrency) {
          startTask(node);
        }
      }
    }
  };

  /** A node failed: fail the run, or with `onError: 'continue'` let the joins decide. */
  const fail = (node: GraphNode<T>, ctx: T, error: string) => {
    node.state = 'failed';
    node.out = ctx;
    if ((node.def.onError ?? 'fail') === 'fail') {
      failure ??= { node, error };
      // The run has failed: stop the nodes still running in other branches.
      for (const c of controllers.values()) c.abort();
    }
    // A failed loop node ends its loop: there is no result to check.
    else closeLoopOf(node);
  };

  /** Send the run back through `region`: its nodes go back to pending. */
  const loopAgain = (region: Region<T>, ctx: T) => {
    region.visit++;
    for (const m of region.members) {
      m.state = 'pending';
      m.out = undefined;
      m.upstreamFailed = undefined;
      m.readFrom = undefined;
      m.feedback = undefined;
    }
    // Loops inside this one start over.
    for (const r of regions) {
      if (r !== region && r.members.size < region.members.size && region.members.has(r.exit)) {
        r.visit = 1;
        r.closed = false;
      }
    }
    region.entry.feedback = ctx;
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
        fail(node, result.ctx, result.error);
        return;
      case 'skipped':
        node.state = 'skipped';
        node.out = result.ctx;
        // A skipped loop node ends its loop, as the last node of a sequential loop did.
        closeLoopOf(node);
        return;
      case 'succeeded': {
        const region = loopOf.get(node);
        if (!region || result.loop !== 'again') {
          node.state = 'succeeded';
          node.out = result.ctx;
          closeLoopOf(node);
          return;
        }
        if (region.visit >= region.maxIterations) {
          const error = `loop exhausted: "${node.def.name}" ran ${region.maxIterations} visits and its until condition never held`;
          emit({
            kind: 'error',
            nodeName: node.def.name,
            ctx: result.ctx,
            iteration: region.visit,
            error,
          });
          fail(node, result.ctx, error);
          return;
        }
        loopAgain(region, result.ctx);
      }
    }
  };

  launchReady();
  while (running.size > 0) {
    const { node, result } = await Promise.race(running.values());
    running.delete(node);
    controllers.delete(node);
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
    stopGraceMs?: number;
    acquireSlot?: (signal: AbortSignal, onWait: () => void) => Promise<() => void>;
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
