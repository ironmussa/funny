/**
 * Graph-level checks of a workflow, run by the schema after each node parsed:
 * node ids, dependencies, loop regions and concurrency groups. Each check
 * returns the messages of what it refuses; the schema reports them as issues.
 */

import { templateVariables } from '@funny/pipelines/templates';

/** The parts of a workflow the graph checks read. */
interface CheckedWorkflow {
  nodes: ReadonlyArray<{
    id: string;
    depends_on: string[];
    loop?: { back_to?: string };
    concurrency?: { group: string };
  }>;
}

type GraphNode = CheckedWorkflow['nodes'][number];

/** Every message the graph checks refuse the workflow with. */
export function graphIssues(workflow: CheckedWorkflow): string[] {
  const ids = new Set(workflow.nodes.map((n) => n.id));
  return [
    ...duplicateIds(workflow),
    ...workflow.nodes.flatMap((n) => dependencyIssues(n, ids)),
    ...loopIssues(workflow, ids),
    ...workflow.nodes.flatMap((n) => concurrencyIssues(n, ids)),
  ];
}

function duplicateIds(workflow: CheckedWorkflow): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const n of workflow.nodes) {
    if (seen.has(n.id)) issues.push(`Duplicate node id: "${n.id}"`);
    seen.add(n.id);
  }
  return issues;
}

function dependencyIssues(n: GraphNode, ids: Set<string>): string[] {
  return n.depends_on.flatMap((dep) => {
    if (dep === n.id) return [`Node "${n.id}" cannot depend on itself`];
    if (!ids.has(dep)) return [`Node "${n.id}" depends_on unknown node "${dep}"`];
    return [];
  });
}

/** A loop's region: every node on a path from `back_to` to the declaring node. */
interface LoopRegion {
  node: string;
  backTo: string;
  members: Set<string>;
}

function loopIssues(workflow: CheckedWorkflow, ids: Set<string>): string[] {
  const depsOf = new Map(workflow.nodes.map((n) => [n.id, n.depends_on]));
  const issues: string[] = [];
  const regions: LoopRegion[] = [];
  for (const n of workflow.nodes) {
    const backTo = n.loop ? (n.loop.back_to ?? n.id) : undefined;
    if (backTo === undefined) continue;
    if (!ids.has(backTo)) {
      issues.push(`Node "${n.id}" loop.back_to references unknown node "${backTo}"`);
      continue;
    }
    const members = regionOf(backTo, n.id, depsOf);
    if (!members) {
      issues.push(
        `Node "${n.id}" loop.back_to "${backTo}" must be "${n.id}" or a node it depends on, directly or not`,
      );
      continue;
    }
    regions.push({ node: n.id, backTo, members });
  }
  return [...issues, ...overlaps(regions)];
}

/** The nodes on a path from `from` to `to` (both included), or null when `from` is not an ancestor. */
export function regionOf(
  from: string,
  to: string,
  depsOf: Map<string, string[]>,
): Set<string> | null {
  const ancestors = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    stack.push(...(depsOf.get(id) ?? []));
  }
  if (!ancestors.has(from)) return null;
  // On a path from `from`: an ancestor of `to` that is `from` or depends (transitively) on it.
  const reachesFrom = (id: string, seen = new Set<string>()): boolean => {
    if (id === from) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (depsOf.get(id) ?? []).some((d) => ancestors.has(d) && reachesFrom(d, seen));
  };
  return new Set([...ancestors].filter((id) => reachesFrom(id)));
}

const within = (inner: Set<string>, outer: Set<string>) => [...inner].every((id) => outer.has(id));

/** Loop regions must be nested or disjoint. */
function overlaps(regions: LoopRegion[]): string[] {
  const issues: string[] = [];
  for (const [i, a] of regions.entries()) {
    for (const b of regions.slice(i + 1)) {
      const shared = [...a.members].some((id) => b.members.has(id));
      if (shared && !within(a.members, b.members) && !within(b.members, a.members)) {
        issues.push(
          `The loops on "${a.node}" (back to "${a.backTo}") and "${b.node}" (back to "${b.backTo}") overlap; loop regions must be nested or disjoint`,
        );
      }
    }
  }
  return issues;
}

/** A concurrency group is computed before the run, from its inputs: it may not read node outputs. */
function concurrencyIssues(n: GraphNode, ids: Set<string>): string[] {
  const group = n.concurrency?.group;
  if (group === undefined) return [];
  let names: string[];
  try {
    names = templateVariables(group);
  } catch (err) {
    return [`Node "${n.id}" concurrency.group is not a valid template: ${String(err)}`];
  }
  const outputs = [...new Set(names.map((name) => name.split('.')[0]))].filter((root) =>
    ids.has(root),
  );
  return outputs.map(
    (root) =>
      `Node "${n.id}" concurrency.group reads the output of node "${root}"; a group may use only the run's inputs`,
  );
}
