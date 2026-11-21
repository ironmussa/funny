import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type {
  WorkflowDefinitionResponse,
  WorkflowListResponse,
} from '@funny/shared/types/workflows';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import * as React from 'react';

const apiMocks = (() => ({
  listWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
  validateWorkflow: vi.fn(),
  saveWorkflow: vi.fn(),
  runWorkflow: vi.fn(),
  cancelWorkflowRun: vi.fn(),
}))();

mock.module('@/lib/api', () => ({
  api: apiMocks,
}));

mock.module('@/stores/app-store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      selectedProjectId: 'project-1',
      selectedThreadId: 'thread-1',
      activeThread: { id: 'thread-1', title: 'Thread one' },
    }),
}));

const actualWorkflowsBrowser = { ...(await import('@funny/workflows/browser')) };
mock.module('@funny/workflows/browser', () => ({
  ...actualWorkflowsBrowser,
  serializeWorkflow: (workflow: { name: string }) => `name: ${workflow.name}\nnodes: []\n`,
  workflowToGraph: () => ({
    nodes: [
      {
        id: 'ask',
        type: 'workflowNode',
        position: { x: 0, y: 0 },
        data: {
          label: 'ask',
          actionType: 'notify',
          onError: 'fail',
          sourceNode: {
            id: 'ask',
            depends_on: [],
            on_error: 'fail',
            notify: { message: 'hi' },
          },
        },
      },
    ],
    edges: [],
  }),
}));

mock.module('@xyflow/react', () => {
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ReactFlow: ({
      nodes,
      children,
    }: {
      nodes: Array<{ id: string; data: { label: string } }>;
      children: React.ReactNode;
    }) => (
      <div data-testid="workflow-graph">
        {nodes.map((node) => (
          <button key={node.id}>{node.data.label}</button>
        ))}
        {children}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = React.useState(initial);
      return [edges, setEdges, vi.fn()];
    },
  };
});

const { WorkflowsSettings } = await import('@/components/WorkflowsSettings');

const listResponse: WorkflowListResponse = {
  workflows: [{ name: 'fusion', source: 'built-in', hasOverride: false }],
  warnings: [],
};

function definition(
  diagnostics: WorkflowDefinitionResponse['diagnostics'] = [],
): WorkflowDefinitionResponse {
  return {
    summary: { name: 'fusion', source: 'built-in', hasOverride: false },
    yaml: 'name: fusion\nnodes:\n  - id: ask\n    notify: { message: hi }\n',
    parsed: {
      name: 'fusion',
      nodes: [
        {
          id: 'ask',
          depends_on: [],
          on_error: 'fail',
          notify: { message: 'hi' },
        },
      ],
    },
    graph: {
      nodes: [
        {
          id: 'ask',
          type: 'workflowNode',
          position: { x: 0, y: 0 },
          data: {
            label: 'ask',
            actionType: 'notify',
            onError: 'fail',
            sourceNode: {
              id: 'ask',
              depends_on: [],
              on_error: 'fail',
              notify: { message: 'hi' },
            },
          },
        },
      ],
      edges: [],
    },
    diagnostics,
  };
}

describe('WorkflowsSettings', () => {
  beforeEach(() => {
    apiMocks.listWorkflows.mockReset();
    apiMocks.getWorkflow.mockReset();
    apiMocks.validateWorkflow.mockReset();
    apiMocks.saveWorkflow.mockReset();
    apiMocks.runWorkflow.mockReset();
    apiMocks.cancelWorkflowRun.mockReset();
    apiMocks.listWorkflows.mockReturnValue(okAsync(listResponse));
    apiMocks.getWorkflow.mockReturnValue(okAsync(definition()));
    apiMocks.validateWorkflow.mockReturnValue(
      okAsync({
        ok: true,
        parsed: definition().parsed,
        graph: definition().graph,
        diagnostics: [],
      }),
    );
    apiMocks.saveWorkflow.mockReturnValue(okAsync({ ok: true, workflow: definition() }));
    apiMocks.runWorkflow.mockReturnValue(okAsync({ runId: 'run-1', pipelineRunId: 'run-1' }));
    apiMocks.cancelWorkflowRun.mockReturnValue(okAsync({ ok: true, found: true }));
  });

  test('loads workflows and saves the selected YAML', async () => {
    render(<WorkflowsSettings />);

    await waitFor(() => {
      expect(screen.getByText('fusion')).toBeInTheDocument();
      expect(screen.getByText('ask')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiMocks.saveWorkflow).toHaveBeenCalledWith(
        'project-1',
        'fusion',
        expect.stringContaining('name: fusion'),
      );
    });
  });

  test('blocks save when diagnostics are present', async () => {
    apiMocks.getWorkflow.mockReturnValue(
      okAsync(definition([{ path: 'nodes.0', message: 'invalid' }])),
    );

    render(<WorkflowsSettings />);

    await waitFor(() => {
      expect(screen.getByText(/nodes.0/)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /run/i })).toBeDisabled();
  });

  test('shows warnings without blocking save or run', async () => {
    apiMocks.getWorkflow.mockReturnValue(
      okAsync(
        definition([
          {
            path: 'nodes.1.trigger_rule',
            message: '"judge" is skipped if "proposer-b" fails (on_error: continue).',
            severity: 'warning',
          },
        ]),
      ),
    );

    render(<WorkflowsSettings />);

    const warning = await screen.findByText(/nodes\.1\.trigger_rule/);
    expect(warning.closest('[data-severity]')).toHaveAttribute('data-severity', 'warning');
    expect(screen.getByRole('button', { name: /run/i })).toBeEnabled();
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(apiMocks.saveWorkflow).toHaveBeenCalled());
  });

  test('one error among warnings still blocks save and run', async () => {
    apiMocks.getWorkflow.mockReturnValue(
      okAsync(
        definition([
          { path: 'nodes.1.trigger_rule', message: 'skipped', severity: 'warning' },
          { path: 'nodes.0', message: 'invalid', severity: 'error' },
        ]),
      ),
    );

    render(<WorkflowsSettings />);

    await screen.findByText(/nodes\.0:/);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /run/i })).toBeDisabled();
  });
});
