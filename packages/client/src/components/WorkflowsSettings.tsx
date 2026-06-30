import type {
  WorkflowDefinitionResponse,
  WorkflowDiagnostic,
  WorkflowGraphDto,
  WorkflowSummary,
} from '@funny/shared/types/workflows';
import {
  serializeWorkflow,
  workflowToGraph,
  type ParsedNode,
  type ParsedWorkflow,
  type WorkflowGraph,
  type WorkflowGraphNodeData,
} from '@funny/workflows/browser';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertCircle,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  GitBranch,
  Play,
  RefreshCw,
  Save,
  Search,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useWorkflowRunStore } from '@/stores/workflow-run-store';

type WorkflowNodeData = WorkflowGraphNodeData &
  Record<string, unknown> & {
    runStatus?: string;
    dimmed?: boolean;
  };
type WorkflowNode = Node<WorkflowNodeData, 'workflowNode'>;

const nodeTypes = { workflowNode: WorkflowNodeView };

interface WorkflowsViewProps {
  projectId?: string | null;
}

export function WorkflowsView({ projectId = null }: WorkflowsViewProps) {
  return (
    <ReactFlowProvider>
      <WorkflowsDesigner projectId={projectId} />
    </ReactFlowProvider>
  );
}

export function WorkflowsSettings() {
  return <WorkflowsView />;
}

function WorkflowsDesigner({ projectId }: { projectId: string | null }) {
  const storeSelectedProjectId = useAppStore((s) => s.selectedProjectId);
  const selectedProjectId = projectId ?? storeSelectedProjectId;
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const activeThread = useAppStore((s) => s.activeThread);
  const activeRunId = useWorkflowRunStore((s) => s.activeRunId);
  const runStates = useWorkflowRunStore((s) => (activeRunId ? s.runs[activeRunId] : undefined));
  const setActiveRun = useWorkflowRunStore((s) => s.setActiveRun);

  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinitionResponse | null>(null);
  const [parsed, setParsed] = useState<ParsedWorkflow | null>(null);
  const [source, setSource] = useState('');
  const [diagnostics, setDiagnostics] = useState<WorkflowDiagnostic[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [inputsSource, setInputsSource] = useState('{}');
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();

  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const selectedNode = useMemo(
    () => parsed?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [parsed, selectedNodeId],
  );

  const loadList = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    const result = await api.listWorkflows(selectedProjectId);
    if (result.isOk()) {
      setSummaries(result.value.workflows);
      setSelectedName((current) => current ?? result.value.workflows[0]?.name ?? null);
    } else {
      toast.error(result.error.message);
    }
    setLoading(false);
  }, [selectedProjectId]);

  const loadWorkflow = useCallback(
    async (name: string) => {
      if (!selectedProjectId) return;
      setLoading(true);
      const result = await api.getWorkflow(selectedProjectId, name);
      if (result.isOk()) {
        applyDefinition(result.value, {
          setDefinition,
          setParsed,
          setSource,
          setDiagnostics,
          setNodes,
          setEdges,
          runStates,
          filter,
        });
        setSelectedNodeId(null);
      } else {
        toast.error(result.error.message);
      }
      setLoading(false);
    },
    [filter, runStates, selectedProjectId, setEdges, setNodes],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedName) void loadWorkflow(selectedName);
  }, [loadWorkflow, selectedName]);

  useEffect(() => {
    if (!parsed) return;
    const graph = workflowToGraph(parsed);
    startTransition(() => {
      applyGraph(graph, setNodes, setEdges, runStates, filter);
    });
  }, [filter, parsed, runStates, setEdges, setNodes]);

  const refreshFromSource = useCallback(async () => {
    const result = await api.validateWorkflow(source);
    if (result.isErr()) {
      toast.error(result.error.message);
      return;
    }
    setDiagnostics(result.value.diagnostics);
    if (!result.value.ok || !result.value.parsed || !result.value.graph) return;
    const nextParsed = result.value.parsed as ParsedWorkflow;
    setParsed(nextParsed);
    applyGraph(result.value.graph as WorkflowGraph, setNodes, setEdges, runStates, filter);
  }, [filter, runStates, setEdges, setNodes, source]);

  const saveWorkflow = useCallback(async () => {
    if (!selectedProjectId || !selectedName || diagnostics.length > 0) return;
    const result = await api.saveWorkflow(selectedProjectId, selectedName, source);
    if (result.isErr()) {
      toast.error(result.error.message);
      return;
    }
    toast.success('Workflow saved');
    applyDefinition(result.value.workflow, {
      setDefinition,
      setParsed,
      setSource,
      setDiagnostics,
      setNodes,
      setEdges,
      runStates,
      filter,
    });
    void loadList();
  }, [
    diagnostics.length,
    filter,
    loadList,
    runStates,
    selectedName,
    selectedProjectId,
    setEdges,
    setNodes,
    source,
  ]);

  const runWorkflow = useCallback(async () => {
    if (!selectedName || diagnostics.length > 0 || !selectedThreadId) return;
    let inputs: Record<string, unknown>;
    try {
      inputs = JSON.parse(inputsSource) as Record<string, unknown>;
    } catch {
      toast.error('Inputs must be valid JSON');
      return;
    }
    const result = await api.runWorkflow(selectedName, {
      threadId: selectedThreadId,
      inputs,
    });
    if (result.isErr()) {
      toast.error(result.error.message);
      return;
    }
    setActiveRun(result.value.runId);
    toast.success('Workflow started');
  }, [diagnostics.length, inputsSource, selectedName, selectedThreadId, setActiveRun]);

  const cancelRun = useCallback(async () => {
    if (!activeRunId) return;
    const result = await api.cancelWorkflowRun(activeRunId);
    if (result.isErr()) toast.error(result.error.message);
    else toast.success('Cancel requested');
  }, [activeRunId]);

  const updateParsed = useCallback(
    (updater: (workflow: ParsedWorkflow) => ParsedWorkflow) => {
      if (!parsed) return;
      const next = updater(parsed);
      setParsed(next);
      setSource(serializeWorkflow(next));
      setDiagnostics([]);
      applyGraph(workflowToGraph(next), setNodes, setEdges, runStates, filter);
    },
    [filter, parsed, runStates, setEdges, setNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `dependency:${connection.source}->${connection.target}`,
            label: 'depends_on',
          },
          eds,
        ),
      );
      updateParsed((workflow) => ({
        ...workflow,
        nodes: workflow.nodes.map((node) =>
          node.id === connection.target
            ? { ...node, depends_on: [...new Set([...node.depends_on, connection.source!])] }
            : node,
        ),
      }));
    },
    [setEdges, updateParsed],
  );

  if (!selectedProjectId) {
    return (
      <div className="flex h-full min-w-0 flex-1 items-center justify-center">
        <p className="text-muted-foreground text-sm">Select a project.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="border-border bg-background flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <GitBranch className="text-muted-foreground icon-base" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Workflows</h1>
          {definition?.summary.source === 'built-in' ? (
            <p className="text-muted-foreground truncate text-xs">
              Saving writes `.funny/workflows/{definition.summary.name}.yaml`.
            </p>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={() => void refreshFromSource()}>
          <RefreshCw className="size-4" />
        </Button>
        <Button
          size="sm"
          onClick={() => void saveWorkflow()}
          disabled={!selectedName || diagnostics.length > 0}
        >
          <Save className="size-4" />
          Save
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void runWorkflow()}
          disabled={!selectedName || diagnostics.length > 0 || !selectedThreadId}
        >
          <Play className="size-4" />
          Run
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void cancelRun()}
          disabled={!activeRunId}
        >
          <Square className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="border-border bg-sidebar/40 flex w-72 shrink-0 flex-col border-r">
          <div className="border-border border-b p-3">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-2 size-4" />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter workflows"
                className="pl-8"
              />
            </div>
          </div>
          <WorkflowList
            summaries={summaries}
            selectedName={selectedName}
            filter={filter}
            onSelect={setSelectedName}
          />
        </aside>

        {loading ? (
          <LoadingState label="Loading workflows..." className="min-h-0 flex-1" />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] max-xl:grid-cols-1">
            <div className="min-h-0 overflow-hidden">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                fitView
              >
                <Background />
                <MiniMap pannable zoomable />
                <Controls />
              </ReactFlow>
            </div>
            <div className="border-border bg-background flex min-h-0 flex-col gap-3 overflow-auto border-l p-3 max-xl:border-t max-xl:border-l-0">
              <RunPanel
                threadLabel={activeThread?.title ?? selectedThreadId ?? 'No thread'}
                inputsSource={inputsSource}
                onInputsChange={setInputsSource}
                activeRunId={activeRunId}
              />
              <Inspector node={selectedNode} workflow={parsed} onUpdate={updateParsed} />
              <SourcePanel
                source={source}
                diagnostics={diagnostics}
                pending={isPending}
                onSourceChange={setSource}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkflowList({
  summaries,
  selectedName,
  filter,
  onSelect,
}: {
  summaries: WorkflowSummary[];
  selectedName: string | null;
  filter: string;
  onSelect: (name: string) => void;
}) {
  const normalized = filter.trim().toLowerCase();
  const visible = normalized
    ? summaries.filter((item) =>
        `${item.name} ${item.description ?? ''}`.toLowerCase().includes(normalized),
      )
    : summaries;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="text-muted-foreground px-3 py-2 text-xs font-medium uppercase">Workflows</div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {visible.map((item) => (
          <button
            key={item.name}
            onClick={() => onSelect(item.name)}
            className={cn(
              'hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm',
              selectedName === item.name && 'bg-accent text-accent-foreground',
            )}
          >
            <GitBranch className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className="text-muted-foreground text-[11px]">
              {item.source === 'user' ? 'user' : 'base'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RunPanel({
  threadLabel,
  inputsSource,
  activeRunId,
  onInputsChange,
}: {
  threadLabel: string;
  inputsSource: string;
  activeRunId: string | null;
  onInputsChange: (value: string) => void;
}) {
  return (
    <section className="border-border rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Run</h3>
        <span className="text-muted-foreground max-w-44 truncate text-xs">
          {activeRunId ?? threadLabel}
        </span>
      </div>
      <Textarea
        value={inputsSource}
        onChange={(event) => onInputsChange(event.target.value)}
        spellCheck={false}
        className="font-mono text-xs"
        rows={4}
      />
    </section>
  );
}

function Inspector({
  node,
  workflow,
  onUpdate,
}: {
  node: ParsedNode | null;
  workflow: ParsedWorkflow | null;
  onUpdate: (updater: (workflow: ParsedWorkflow) => ParsedWorkflow) => void;
}) {
  const action = useMemo(() => (node ? actionOf(node) : null), [node]);
  const [actionSource, setActionSource] = useState('{}');
  const [retrySource, setRetrySource] = useState('');
  const [loopSource, setLoopSource] = useState('');

  useEffect(() => {
    setActionSource(JSON.stringify(action?.value ?? {}, null, 2));
    setRetrySource(node?.retry ? JSON.stringify(node.retry, null, 2) : '');
    setLoopSource(node?.loop ? JSON.stringify(node.loop, null, 2) : '');
  }, [action, node?.loop, node?.retry]);

  if (!node || !workflow || !action) {
    return (
      <section className="border-border rounded-md border p-3">
        <h3 className="text-sm font-medium">Inspector</h3>
      </section>
    );
  }

  const updateNode = (patch: Partial<ParsedNode>) => {
    onUpdate((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === node.id ? ({ ...item, ...patch } as ParsedNode) : item,
      ),
    }));
  };

  const applyAction = () => {
    try {
      const value = JSON.parse(actionSource);
      onUpdate((current) => ({
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === node.id ? ({ ...item, [action.type]: value } as ParsedNode) : item,
        ),
      }));
    } catch {
      toast.error('Action JSON is invalid');
    }
  };

  const changeActionType = (nextType: (typeof ACTION_KEYS)[number]) => {
    onUpdate((current) => ({
      ...current,
      nodes: current.nodes.map((item) => {
        if (item.id !== node.id) return item;
        const cleared = { ...item };
        for (const key of ACTION_KEYS) delete (cleared as Record<string, unknown>)[key];
        return { ...cleared, [nextType]: defaultActionValue(nextType) } as ParsedNode;
      }),
    }));
  };

  const applyJsonField = (field: 'retry' | 'loop', value: string) => {
    if (!value.trim()) {
      updateNode({ [field]: undefined } as Partial<ParsedNode>);
      return;
    }
    try {
      updateNode({ [field]: JSON.parse(value) } as Partial<ParsedNode>);
    } catch {
      toast.error(`${field} JSON is invalid`);
    }
  };

  return (
    <section className="border-border rounded-md border p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Inspector</h3>
        <span className="text-muted-foreground text-xs">{action.type}</span>
      </div>
      <div className="grid gap-2">
        <Input
          value={node.id}
          onChange={(event) => updateNode({ id: event.target.value })}
          className="h-8"
        />
        <Input
          value={node.depends_on.join(', ')}
          onChange={(event) =>
            updateNode({
              depends_on: event.target.value
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            })
          }
          className="h-8"
        />
        <select
          value={action.type}
          onChange={(event) => changeActionType(event.target.value as (typeof ACTION_KEYS)[number])}
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
        >
          {ACTION_KEYS.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <Input
          value={node.when ?? ''}
          onChange={(event) => updateNode({ when: event.target.value || undefined })}
          className="h-8"
        />
        <select
          value={node.on_error}
          onChange={(event) =>
            updateNode({ on_error: event.target.value as ParsedNode['on_error'] })
          }
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
        >
          <option value="fail">fail</option>
          <option value="continue">continue</option>
          <option value="retry">retry</option>
        </select>
        <Textarea
          value={actionSource}
          onChange={(event) => setActionSource(event.target.value)}
          onBlur={applyAction}
          spellCheck={false}
          className="min-h-28 font-mono text-xs"
        />
        <Textarea
          value={retrySource}
          onChange={(event) => setRetrySource(event.target.value)}
          onBlur={() => applyJsonField('retry', retrySource)}
          placeholder='{"max_attempts":2}'
          spellCheck={false}
          className="min-h-20 font-mono text-xs"
        />
        <Textarea
          value={loopSource}
          onChange={(event) => setLoopSource(event.target.value)}
          onBlur={() => applyJsonField('loop', loopSource)}
          placeholder='{"until":"done = true","back_to":"review"}'
          spellCheck={false}
          className="min-h-20 font-mono text-xs"
        />
      </div>
    </section>
  );
}

function SourcePanel({
  source,
  diagnostics,
  pending,
  onSourceChange,
}: {
  source: string;
  diagnostics: WorkflowDiagnostic[];
  pending: boolean;
  onSourceChange: (value: string) => void;
}) {
  return (
    <section className="border-border flex min-h-72 flex-1 flex-col rounded-md border">
      <div className="border-border flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-medium">YAML</h3>
        {pending ? <CircleDashed className="text-muted-foreground size-4 animate-spin" /> : null}
      </div>
      <Textarea
        value={source}
        onChange={(event) => onSourceChange(event.target.value)}
        spellCheck={false}
        className="min-h-64 flex-1 resize-none rounded-none border-0 font-mono text-xs focus-visible:ring-0"
      />
      {diagnostics.length > 0 ? (
        <div className="border-border max-h-28 overflow-auto border-t p-2">
          {diagnostics.map((diagnostic, index) => (
            <div
              key={`${diagnostic.path}-${index}`}
              className="text-destructive flex gap-2 text-xs"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {diagnostic.path}: {diagnostic.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function WorkflowNodeView({ data }: NodeProps<WorkflowNode>) {
  const status = data.runStatus;
  const StatusIcon =
    status === 'completed'
      ? CircleCheck
      : status === 'failed'
        ? CircleX
        : status === 'running' || status === 'waiting_approval'
          ? CircleDashed
          : status === 'skipped'
            ? Circle
            : Circle;

  return (
    <div
      className={cn(
        'border-border bg-background min-w-52 rounded-md border p-3 shadow-sm',
        data.dimmed && 'opacity-35',
        status === 'running' && 'border-blue-500',
        status === 'waiting_approval' && 'border-amber-500',
        status === 'completed' && 'border-emerald-500',
        status === 'failed' && 'border-red-500',
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
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function applyDefinition(
  definition: WorkflowDefinitionResponse,
  setters: {
    setDefinition: (value: WorkflowDefinitionResponse) => void;
    setParsed: (value: ParsedWorkflow) => void;
    setSource: (value: string) => void;
    setDiagnostics: (value: WorkflowDiagnostic[]) => void;
    setNodes: ReturnType<typeof useNodesState<WorkflowNode>>[1];
    setEdges: ReturnType<typeof useEdgesState<Edge>>[1];
    runStates: ReturnType<typeof useWorkflowRunStore.getState>['runs'][string] | undefined;
    filter: string;
  },
) {
  const parsed = definition.parsed as ParsedWorkflow;
  setters.setDefinition(definition);
  setters.setParsed(parsed);
  setters.setSource(definition.yaml);
  setters.setDiagnostics(definition.diagnostics);
  applyGraph(
    definition.graph,
    setters.setNodes,
    setters.setEdges,
    setters.runStates,
    setters.filter,
  );
}

function applyGraph(
  graph: WorkflowGraph | WorkflowGraphDto,
  setNodes: ReturnType<typeof useNodesState<WorkflowNode>>[1],
  setEdges: ReturnType<typeof useEdgesState<Edge>>[1],
  runStates: ReturnType<typeof useWorkflowRunStore.getState>['runs'][string] | undefined,
  filter: string,
) {
  const normalized = filter.trim().toLowerCase();
  setNodes(
    (graph.nodes as WorkflowNode[]).map((node) => ({
      ...node,
      data: {
        ...node.data,
        runStatus: runStates?.[node.id]?.status,
        dimmed:
          normalized.length > 0 &&
          !`${node.id} ${node.data.actionType}`.toLowerCase().includes(normalized),
      },
    })),
  );
  setEdges(
    (graph.edges as Edge[]).map((edge) => ({
      ...edge,
      animated: edge.label === 'loop',
      type: edge.label === 'loop' ? 'smoothstep' : undefined,
    })),
  );
}

function actionOf(node: ParsedNode): { type: keyof ParsedNode; value: unknown } {
  for (const key of ACTION_KEYS) {
    const value = node[key];
    if (value !== undefined) return { type: key, value };
  }
  return { type: 'notify', value: {} };
}

const ACTION_KEYS = [
  'spawn_agent',
  'run_command',
  'bash',
  'git_commit',
  'git_push',
  'create_pr',
  'notify',
  'set_status',
  'set_stage',
  'approval',
  'pipeline',
] as const;

function defaultActionValue(actionType: (typeof ACTION_KEYS)[number]): Record<string, unknown> {
  switch (actionType) {
    case 'spawn_agent':
      return { prompt: '' };
    case 'run_command':
    case 'bash':
      return { command: '' };
    case 'git_commit':
      return { message: '' };
    case 'git_push':
      return {};
    case 'create_pr':
      return { title: '' };
    case 'notify':
      return { message: '' };
    case 'set_status':
    case 'set_stage':
      return { value: '' };
    case 'approval':
      return { message: '' };
    case 'pipeline':
      return { name: '' };
  }
}
