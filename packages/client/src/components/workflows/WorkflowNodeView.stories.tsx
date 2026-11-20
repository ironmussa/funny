import type { WorkflowNodeRunState } from '@funny/shared/types/workflows';
import { parseWorkflowYaml, workflowToGraph } from '@funny/workflows/browser';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Background, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { expect, within } from 'storybook/test';
import '@xyflow/react/dist/style.css';

import { decorateGraph, WorkflowNodeView } from './WorkflowNodeView';

const nodeTypes = { workflowNode: WorkflowNodeView };

/** Nested loops (`review` inside `ci` → `implement`), a join and a merge group. */
const YAML = `name: review-and-merge
description: Implement, review until clean, CI, then merge one pull request at a time
nodes:
  - id: implement
    spawn_agent: { prompt: Implement the issue }
  - id: review
    depends_on: [implement]
    spawn_agent: { prompt: Review the change }
    loop: { until: "$review.ok", max_iterations: 2 }
  - id: ci
    depends_on: [review]
    wait_ci: {}
    loop: { until: "$ci.ok", back_to: implement, max_iterations: 3 }
  - id: notify
    depends_on: [implement]
    notify: { message: Pull request opened }
  - id: merge
    depends_on: [ci, notify]
    trigger_rule: all_done
    concurrency: { group: "merge-{{inputs.repo}}", limit: 1 }
    merge: {}
`;

function states(entries: Array<[string, WorkflowNodeRunState['status']]>) {
  return Object.fromEntries(
    entries.map(([nodeId, status]) => [
      nodeId,
      { runId: 'run-1', workflowName: 'review-and-merge', nodeId, status },
    ]),
  );
}

function Canvas({ runStates }: { runStates?: Record<string, WorkflowNodeRunState> }) {
  const parsed = parseWorkflowYaml(YAML);
  if (!parsed.ok) return <pre>{parsed.error.message}</pre>;
  const { nodes, edges } = decorateGraph(workflowToGraph(parsed.workflow), runStates, '');
  return (
    <ReactFlowProvider>
      <div className="h-[520px] w-full">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
          <Background />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}

const meta = {
  title: 'Workflows/WorkflowNodeView',
  component: Canvas,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Canvas>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The flow view: loop regions, the `all done` join and the merge group. */
export const Flow: Story = {};

/** A run in its second review: `notify` done, `review` running. */
export const Running: Story = {
  args: {
    runStates: states([
      ['implement', 'completed'],
      ['notify', 'completed'],
      ['review', 'running'],
    ]),
  },
};

/** Another run of the repository holds the merge slot, so this one waits. */
export const WaitingSlot: Story = {
  args: {
    runStates: states([
      ['implement', 'completed'],
      ['review', 'completed'],
      ['ci', 'completed'],
      ['notify', 'completed'],
      ['merge', 'waiting_slot'],
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const merge = await canvas.findByTestId('workflow-node-merge');
    await expect(merge.dataset.status).toBe('waiting_slot');
    await expect(canvas.getByTestId('workflow-node-waiting-slot-merge')).toHaveTextContent(
      'Waiting for a slot of merge-{{inputs.repo}}',
    );
    await expect(canvas.getByTestId('workflow-node-join-merge')).toHaveTextContent('all done');
    await expect(canvas.getByTestId('workflow-node-loop-review-review')).toBeInTheDocument();
  },
};
