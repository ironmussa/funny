import { ACTION_KEYS, type ParsedNode, type ParsedWorkflow } from './schema.js';
import { regionOf } from './validate.js';

export interface WorkflowGraphPosition {
  x: number;
  y: number;
}

export type WorkflowGraphEdgeKind = 'dependency' | 'loop' | 'subworkflow';

export interface WorkflowGraphNodeData {
  label: string;
  actionType: string;
  description?: string;
  when?: string;
  onError: ParsedNode['on_error'];
  /** How the node joins its dependencies; absent means the default, `all_success`. */
  triggerRule?: ParsedNode['trigger_rule'];
  /** The node's concurrency group (its template, as written) and limit. */
  concurrency?: ParsedNode['concurrency'];
  retry?: ParsedNode['retry'];
  loop?: ParsedNode['loop'];
  approval?: ParsedNode['approval'];
  subworkflowName?: string;
  sourceNode: ParsedNode;
}

export interface WorkflowGraphNode {
  id: string;
  type: 'workflowNode';
  position: WorkflowGraphPosition;
  data: WorkflowGraphNodeData;
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: WorkflowGraphEdgeKind;
  /** For a loop edge: every node of the loop's region, in declaration order. */
  region?: string[];
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

export function workflowToGraph(workflow: ParsedWorkflow): WorkflowGraph {
  const levels = computeLevels(workflow);
  const levelOffsets = new Map<number, number>();
  const nodes: WorkflowGraphNode[] = workflow.nodes.map((node) => {
    const level = levels.get(node.id) ?? 0;
    const offset = levelOffsets.get(level) ?? 0;
    levelOffsets.set(level, offset + 1);
    const action = getWorkflowNodeAction(node);

    return {
      id: node.id,
      type: 'workflowNode',
      position: { x: level * 280, y: offset * 150 },
      data: {
        label: node.id,
        actionType: action.type,
        when: node.when,
        onError: node.on_error,
        triggerRule: node.trigger_rule,
        concurrency: node.concurrency,
        retry: node.retry,
        loop: node.loop,
        approval: node.approval,
        subworkflowName: node.pipeline?.name,
        sourceNode: node,
      },
    };
  });

  const depsOf = new Map(workflow.nodes.map((n) => [n.id, n.depends_on]));
  const order = workflow.nodes.map((n) => n.id);
  const edges: WorkflowGraphEdge[] = [];
  for (const node of workflow.nodes) {
    for (const dep of node.depends_on) {
      edges.push({
        id: `dependency:${dep}->${node.id}`,
        source: dep,
        target: node.id,
        kind: 'dependency',
      });
    }
    if (node.loop) {
      const target = node.loop.back_to ?? node.id;
      const members = regionOf(target, node.id, depsOf) ?? new Set([node.id]);
      edges.push({
        id: `loop:${node.id}->${target}`,
        source: node.id,
        target,
        label: `loop ×${node.loop.max_iterations}`,
        kind: 'loop',
        region: order.filter((id) => members.has(id)),
      });
    }
    if (node.pipeline?.name) {
      edges.push({
        id: `subworkflow:${node.id}->${node.pipeline.name}`,
        source: node.id,
        target: node.pipeline.name,
        label: node.pipeline.name,
        kind: 'subworkflow',
      });
    }
  }

  return { nodes, edges };
}

export function graphToWorkflow(workflow: ParsedWorkflow, graph: WorkflowGraph): ParsedWorkflow {
  const dependencyByTarget = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'dependency') continue;
    const deps = dependencyByTarget.get(edge.target) ?? [];
    deps.push(edge.source);
    dependencyByTarget.set(edge.target, deps);
  }

  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => ({
      ...node,
      depends_on: dedupe(dependencyByTarget.get(node.id) ?? []),
    })),
  };
}

export function getWorkflowNodeAction(node: ParsedNode): { type: string; value: unknown } {
  for (const key of ACTION_KEYS) {
    const value = node[key];
    if (value !== undefined) return { type: key, value };
  }
  return { type: 'unknown', value: undefined };
}

function computeLevels(workflow: ParsedWorkflow): Map<string, number> {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();

  function levelOf(nodeId: string, seen = new Set<string>()): number {
    const existing = memo.get(nodeId);
    if (existing !== undefined) return existing;
    if (seen.has(nodeId)) return 0;
    const node = byId.get(nodeId);
    if (!node || node.depends_on.length === 0) {
      memo.set(nodeId, 0);
      return 0;
    }
    seen.add(nodeId);
    const level = Math.max(...node.depends_on.map((dep) => levelOf(dep, seen) + 1));
    seen.delete(nodeId);
    memo.set(nodeId, level);
    return level;
  }

  for (const node of workflow.nodes) levelOf(node.id);
  return memo;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
