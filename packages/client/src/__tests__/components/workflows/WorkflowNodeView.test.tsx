/**
 * A workflow node on the flow and run canvases (change workflow-dag-engine,
 * task 5.1): loop regions, join rules, concurrency groups and the
 * `waiting_slot` state, from a real `workflowToGraph` graph.
 */
import type { WorkflowNodeRunState } from '@funny/shared/types/workflows';
import { parseWorkflowYaml, workflowToGraph } from '@funny/workflows/browser';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import {
  decorateGraph,
  WorkflowNodeView,
  type WorkflowNode,
} from '@/components/workflows/WorkflowNodeView';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}));

const YAML = `name: review-and-merge
description: test
nodes:
  - id: implement
    spawn_agent: { prompt: implement }
  - id: review
    depends_on: [implement]
    spawn_agent: { prompt: review }
    loop: { until: "$review.ok", max_iterations: 2 }
  - id: ci
    depends_on: [review]
    wait_ci: {}
    loop: { until: "$ci.ok", back_to: implement, max_iterations: 3 }
  - id: notify
    depends_on: [implement]
    notify: { message: done }
  - id: merge
    depends_on: [ci, notify]
    trigger_rule: all_done
    concurrency: { group: "merge-{{inputs.repo}}", limit: 1 }
    merge: {}
`;

function graph() {
  const parsed = parseWorkflowYaml(YAML);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return workflowToGraph(parsed.workflow);
}

function state(nodeId: string, status: WorkflowNodeRunState['status']): WorkflowNodeRunState {
  return { runId: 'run-1', workflowName: 'review-and-merge', nodeId, status };
}

function renderNode(node: WorkflowNode) {
  // SAFETY: the view reads only `id` and `data` of its React Flow props.
  const props = { id: node.id, data: node.data } as Parameters<typeof WorkflowNodeView>[0];
  return render(<WorkflowNodeView {...props} />);
}

function decorated(runStates?: Record<string, WorkflowNodeRunState>, filter = '') {
  const { nodes, edges } = decorateGraph(graph(), runStates, filter);
  const byId = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new Error(`no node ${id}`);
    return node;
  };
  return { nodes, edges, byId };
}

describe('decorateGraph', () => {
  test('every node of a loop region carries its loops, outermost first', () => {
    const { byId } = decorated();
    expect(byId('implement').data.loops).toEqual(['ci']);
    expect(byId('review').data.loops).toEqual(['ci', 'review']);
    expect(byId('ci').data.loops).toEqual(['ci']);
    expect(byId('notify').data.loops).toBeUndefined();
    expect(byId('merge').data.loops).toBeUndefined();
  });

  test('loop edges are animated and drop the graph-only fields', () => {
    const { edges } = decorated();
    const loop = edges.find((e) => e.id === 'loop:ci->implement');
    expect(loop).toMatchObject({ animated: true, type: 'smoothstep', label: 'loop ×3' });
    expect(loop).not.toHaveProperty('region');
    expect(loop).not.toHaveProperty('kind');
    expect(edges.find((e) => e.id === 'dependency:implement->review')?.animated).toBe(false);
  });

  test('a node takes its status from the run and the filter dims the others', () => {
    const { byId } = decorated({ merge: state('merge', 'waiting_slot') }, 'merge');
    expect(byId('merge').data.runStatus).toBe('waiting_slot');
    expect(byId('merge').data.dimmed).toBe(false);
    expect(byId('ci').data.runStatus).toBeUndefined();
    expect(byId('ci').data.dimmed).toBe(true);
  });
});

describe('WorkflowNodeView', () => {
  test('a node waiting for its group slot says so and names the group', () => {
    const { byId } = decorated({ merge: state('merge', 'waiting_slot') });
    renderNode(byId('merge'));
    const node = screen.getByTestId('workflow-node-merge');
    expect(node.dataset.status).toBe('waiting_slot');
    expect(screen.getByTestId('workflow-node-waiting-slot-merge').textContent).toBe(
      'Waiting for a slot of merge-{{inputs.repo}}',
    );
  });

  test('a join rule other than the default and the concurrency group are shown', () => {
    const { byId } = decorated();
    renderNode(byId('merge'));
    expect(screen.getByTestId('workflow-node-join-merge').textContent).toBe('all done');
    expect(screen.getByTestId('workflow-node-group-merge').textContent).toBe(
      'merge-{{inputs.repo}} ≤ 1',
    );
    expect(screen.queryByTestId('workflow-node-waiting-slot-merge')).toBeNull();
  });

  test('a node inside nested loops shows both, and the default join shows nothing', () => {
    const { byId } = decorated({ review: state('review', 'running') });
    renderNode(byId('review'));
    const node = screen.getByTestId('workflow-node-review');
    expect(node.dataset.status).toBe('running');
    expect(within(node).getByTestId('workflow-node-loop-review-ci').textContent).toBe('loop ci');
    expect(within(node).getByTestId('workflow-node-loop-review-review').textContent).toBe(
      'loop review',
    );
    expect(screen.queryByTestId('workflow-node-join-review')).toBeNull();
    expect(screen.queryByTestId('workflow-node-group-review')).toBeNull();
  });

  test('a node outside a run is idle', () => {
    const { byId } = decorated();
    renderNode(byId('notify'));
    expect(screen.getByTestId('workflow-node-notify').dataset.status).toBe('idle');
  });
});
