/**
 * A workflow node on the flow and run canvases (change workflow-dag-engine,
 * task 5.1): its run status (including `waiting_slot`, waiting for a slot of
 * its concurrency group), the loops whose region it belongs to, a join rule
 * other than the default, and its concurrency group.
 *
 * `decorateGraph` turns a `workflowToGraph` graph plus a run's node states
 * into what React Flow draws.
 */

import type { WorkflowGraphDto, WorkflowNodeRunState } from '@funny/shared/types/workflows';
import type { WorkflowGraph, WorkflowGraphNodeData } from '@funny/workflows/browser';
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Hourglass,
  Merge,
  Repeat,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

export type WorkflowNodeData = WorkflowGraphNodeData &
  Record<string, unknown> & {
    runStatus?: WorkflowNodeRunState['status'];
    dimmed?: boolean;
    /** The nodes declaring a loop whose region holds this node, outermost first. */
    loops?: string[];
  };
export type WorkflowNode = Node<WorkflowNodeData, 'workflowNode'>;

const STATUS_ICON: Partial<Record<WorkflowNodeRunState['status'], LucideIcon>> = {
  completed: CircleCheck,
  failed: CircleX,
  running: CircleDashed,
  waiting_approval: CircleDashed,
  waiting_slot: Hourglass,
};

const JOIN_LABEL = {
  all_done: 'all done',
  one_success: 'one success',
} as const;

const STATUS_BORDER: Partial<Record<WorkflowNodeRunState['status'], string>> = {
  running: 'border-status-info',
  waiting_approval: 'border-status-warning',
  waiting_slot: 'border-status-warning border-dashed',
  completed: 'border-status-success',
  failed: 'border-status-error',
};

export function WorkflowNodeView({ id, data }: NodeProps<WorkflowNode>) {
  const status = data.runStatus;
  const StatusIcon = (status && STATUS_ICON[status]) || Circle;

  return (
    <div
      data-testid={`workflow-node-${id}`}
      data-status={status ?? 'idle'}
      className={cn(
        'border-border bg-background min-w-52 rounded-md border p-3 shadow-sm',
        data.dimmed && 'opacity-35',
        (data.loops?.length ?? 0) > 0 && 'ring-status-info/30 ring-2 ring-offset-1',
        status && STATUS_BORDER[status],
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-start gap-2">
        <StatusIcon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{data.label}</div>
          <div className="text-muted-foreground truncate text-xs">{data.actionType}</div>
        </div>
      </div>
      {status === 'waiting_slot' ? (
        <div
          data-testid={`workflow-node-waiting-slot-${id}`}
          className="text-status-warning mt-2 text-xs"
        >
          Waiting for a slot{data.concurrency ? ` of ${data.concurrency.group}` : ''}
        </div>
      ) : null}
      <NodeBadges id={id} data={data} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** The node's loops, a join rule other than the default, and its concurrency group. */
function NodeBadges({ id, data }: { id: string; data: WorkflowNodeData }) {
  const join =
    data.triggerRule && data.triggerRule !== 'all_success' ? JOIN_LABEL[data.triggerRule] : null;
  const loops = data.loops ?? [];
  if (!join && !data.concurrency && loops.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {loops.map((loop) => (
        <Badge key={loop} testId={`workflow-node-loop-${id}-${loop}`} icon={Repeat}>
          loop {loop}
        </Badge>
      ))}
      {join ? (
        <Badge testId={`workflow-node-join-${id}`} icon={Merge}>
          {join}
        </Badge>
      ) : null}
      {data.concurrency ? (
        <Badge testId={`workflow-node-group-${id}`} icon={Users}>
          {data.concurrency.group} ≤ {data.concurrency.limit}
        </Badge>
      ) : null}
    </div>
  );
}

function Badge({
  testId,
  icon: Icon,
  children,
}: {
  testId: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <span
      data-testid={testId}
      className="bg-muted text-muted-foreground text-compact inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5"
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

type GraphEdge = Edge & { kind?: string; region?: string[] };

/**
 * React Flow nodes and edges for a graph: each node with its run status, its
 * loops and whether the filter dims it; loop edges animated.
 */
export function decorateGraph(
  graph: WorkflowGraph | WorkflowGraphDto,
  runStates: Record<string, WorkflowNodeRunState> | undefined,
  filter: string,
): { nodes: WorkflowNode[]; edges: Edge[] } {
  // SAFETY: both graph sources are built by workflowToGraph, whose edges carry `kind`.
  const graphEdges = graph.edges as GraphEdge[];
  const loopsOf = new Map<string, string[]>();
  // A region holds every node of the regions inside it, so the bigger the
  // region, the further out the loop.
  const loopEdges = graphEdges
    .filter((edge) => edge.kind === 'loop')
    .sort((a, b) => (b.region?.length ?? 1) - (a.region?.length ?? 1));
  for (const edge of loopEdges) {
    for (const member of edge.region ?? [edge.source]) {
      loopsOf.set(member, [...(loopsOf.get(member) ?? []), edge.source]);
    }
  }

  const normalized = filter.trim().toLowerCase();
  // SAFETY: both graph sources are built by workflowToGraph, whose nodes have type 'workflowNode'
  // and WorkflowGraphNodeData data; the extra WorkflowNodeData fields are optional.
  const nodes = (graph.nodes as WorkflowNode[]).map((node) => ({
    ...node,
    data: {
      ...node.data,
      runStatus: runStates?.[node.id]?.status,
      loops: loopsOf.get(node.id),
      dimmed:
        normalized.length > 0 &&
        !`${node.id} ${node.data.actionType}`.toLowerCase().includes(normalized),
    },
  }));
  const edges = graphEdges.map(({ kind, region: _region, ...edge }) => ({
    ...edge,
    // The label of a loop edge carries its max iterations, so match on the kind.
    animated: kind === 'loop',
    type: kind === 'loop' ? 'smoothstep' : undefined,
  }));
  return { nodes, edges };
}
