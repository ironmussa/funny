/**
 * The graph a run executes: nodes linked to their dependencies, loop
 * regions, and the rules that read them (joins, region visibility, visits).
 * Built once per run by `buildGraph`; the scheduler mutates node states.
 */

import type { GuardFn, PipelineDefinition, PipelineNode, TriggerRule } from './engine.js';

export type NodeState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface GraphNode<T> {
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

export interface Region<T> {
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

export interface Graph<T> {
  nodes: GraphNode<T>[];
  regions: Region<T>[];
}

/** Build the graph, refusing cycles, unknown dependencies and loops that are not regions. */
export function buildGraph<T>(pipeline: PipelineDefinition<T>, maxIterations?: number): Graph<T> {
  const { nodes, byName } = linkNodes(pipeline.nodes);
  return { nodes, regions: buildRegions(loopSpecs(pipeline, nodes, maxIterations), byName) };
}

/** The dependency names of each node: `dependsOn`, or the previous node when no node declares it. */
function dependencyNames<T>(defs: PipelineNode<T>[]): string[][] {
  const implicitChain = !defs.some((n) => n.dependsOn !== undefined);
  if (implicitChain) return defs.map((_, i) => (i === 0 ? [] : [defs[i - 1].name]));
  return defs.map((n) => n.dependsOn ?? []);
}

function linkNodes<T>(defs: PipelineNode<T>[]) {
  const names = dependencyNames(defs);
  checkEdges(defs.map((n, i) => [n.name, names[i]]));
  const nodes: GraphNode<T>[] = defs.map((def, index) => ({
    def,
    index,
    deps: [],
    dependents: [],
    state: 'pending',
  }));
  const byName = new Map(nodes.map((n) => [n.def.name, n]));
  for (const [i, node] of nodes.entries()) {
    for (const name of names[i]) {
      const dep = byName.get(name)!;
      node.deps.push(dep);
      dep.dependents.push(node);
    }
  }
  return { nodes, byName };
}

/** Every loop of the pipeline: those on nodes, and the pipeline-level one on the last node. */
function loopSpecs<T>(
  pipeline: PipelineDefinition<T>,
  nodes: GraphNode<T>[],
  maxIterations: number | undefined,
): LoopSpec<T>[] {
  const specs: LoopSpec<T>[] = nodes.flatMap((exit) => {
    const loop = exit.def.loop;
    if (!loop) return [];
    const { backTo, until } = loop;
    return [{ exit, backTo, until, maxIterations: loop.maxIterations ?? 10 }];
  });
  const legacy = pipeline.loop;
  const exit = nodes.at(-1);
  if (!legacy || !exit) return specs;
  if (exit.def.loop) {
    throw new Error(`"${exit.def.name}" declares a loop and is also the end of the pipeline loop`);
  }
  const max = maxIterations ?? legacy.maxIterations ?? 10;
  return [...specs, { exit, backTo: legacy.from, until: legacy.until, maxIterations: max }];
}

/** Refuse a dependency on an unknown node, and cycles (naming the path). */
function checkEdges(edges: [name: string, deps: string[]][]): void {
  const depsOf = new Map(edges);
  const done = new Set<string>();
  const visit = (name: string, path: string[]) => {
    if (done.has(name)) return;
    if (path.includes(name)) throw new Error(`Cycle detected: ${[...path, name].join(' → ')}`);
    const deps = depsOf.get(name);
    if (!deps) throw new Error(`Node "${name}" referenced in dependsOn does not exist`);
    for (const d of deps) visit(d, [...path, name]);
    done.add(name);
  };
  for (const [name] of edges) visit(name, []);
}

/** Compute each loop's region, refuse overlaps, and link every node to its innermost region. */
function buildRegions<T>(specs: LoopSpec<T>[], byName: Map<string, GraphNode<T>>): Region<T>[] {
  const regions = specs.map((spec) => regionOf(spec, byName));
  refuseOverlaps(regions);
  // Smallest first, so the first region found containing something is the innermost.
  const bySize = [...regions].sort((a, b) => a.members.size - b.members.size);
  for (const r of bySize) r.parent = bySize.find((o) => contains(o, r));
  for (const r of [...bySize].reverse()) for (const m of r.members) m.region = r;
  return regions;
}

function regionOf<T>(spec: LoopSpec<T>, byName: Map<string, GraphNode<T>>): Region<T> {
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
  const maxIterations = Math.max(1, spec.maxIterations);
  return {
    entry,
    exit: spec.exit,
    members,
    until: spec.until,
    maxIterations,
    visit: 1,
    closed: false,
  };
}

/** Does `outer` strictly contain `inner`? */
export const contains = <T>(outer: Region<T>, inner: Region<T>) =>
  outer.members.size > inner.members.size && [...inner.members].every((m) => outer.members.has(m));

function refuseOverlaps<T>(regions: Region<T>[]): void {
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
}

/** Every node on a path from `entry` to `exit`, both included, or null when there is none. */
function regionBetween<T>(entry: GraphNode<T>, exit: GraphNode<T>): Set<GraphNode<T>> | null {
  const ancestorsOfExit = reachable(exit, (n) => n.deps);
  if (!ancestorsOfExit.has(entry)) return null;
  return reachable(entry, (n) => n.dependents.filter((d) => ancestorsOfExit.has(d)));
}

function reachable<T>(from: GraphNode<T>, next: (n: GraphNode<T>) => GraphNode<T>[]) {
  const seen = new Set<GraphNode<T>>();
  const stack = [from];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...next(n));
  }
  return seen;
}

export const finished = (s: NodeState) => s === 'succeeded' || s === 'skipped' || s === 'failed';

/** `region` and every region around it, innermost first. */
function enclosing<T>(region: Region<T> | undefined): Region<T>[] {
  const out: Region<T>[] = [];
  for (let r = region; r; r = r.parent) out.push(r);
  return out;
}

/** The visits of the regions around `node`, outermost first ("1" outside loops). */
export const visitPath = <T>(node: GraphNode<T>) =>
  enclosing(node.region)
    .reverse()
    .map((r) => r.visit)
    .join('.') || '1';

/** May `node` read `dep`'s result now? Not while a loop around `dep` but not `node` is open. */
export const readable = <T>(node: GraphNode<T>, dep: GraphNode<T>) =>
  finished(dep.state) && enclosing(dep.region).every((r) => r.closed || r.members.has(node));

/** Did `dep` fail, for a dependent's join (a node skipped by a failure counts)? */
const failedForJoin = <T>(dep: GraphNode<T>) =>
  dep.state === 'failed' || (dep.state === 'skipped' && dep.upstreamFailed === true);

export type JoinDecision = 'start' | 'skip' | 'wait';

/** Each trigger rule, given the dependencies `done` so far and whether that is all of them. */
const JOIN_RULES: Record<
  TriggerRule,
  <T>(done: GraphNode<T>[], allDone: boolean, depCount: number) => JoinDecision
> = {
  all_done: (_done, allDone) => (allDone ? 'start' : 'wait'),
  one_success: (done, allDone, depCount) => {
    if (depCount === 0 || done.some((d) => d.state === 'succeeded')) return 'start';
    return allDone ? 'skip' : 'wait';
  },
  all_success: (done, allDone) => {
    if (done.some(failedForJoin)) return 'skip';
    return allDone ? 'start' : 'wait';
  },
};

/** What `node`'s trigger rule says now: start it, skip it, or wait. */
export function joinDecision<T>(node: GraphNode<T>): JoinDecision {
  const done = node.deps.filter((d) => readable(node, d));
  const rule = JOIN_RULES[node.def.triggerRule ?? 'all_success'];
  return rule(done, done.length === node.deps.length, node.deps.length);
}
