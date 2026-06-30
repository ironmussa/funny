import { describe, expect, test, beforeEach } from 'vitest';

import { useWorkflowRunStore } from '@/stores/workflow-run-store';

describe('workflow run store', () => {
  beforeEach(() => {
    useWorkflowRunStore.setState({ runs: {}, activeRunId: null });
  });

  test('stores node state by run id and node id', () => {
    useWorkflowRunStore.getState().handleNodeState({
      runId: 'run-1',
      workflowName: 'fusion',
      nodeId: 'judge',
      status: 'running',
    });

    expect(useWorkflowRunStore.getState().activeRunId).toBe('run-1');
    expect(useWorkflowRunStore.getState().runs['run-1'].judge.status).toBe('running');

    useWorkflowRunStore.getState().handleNodeState({
      runId: 'run-1',
      workflowName: 'fusion',
      nodeId: 'judge',
      status: 'completed',
    });

    expect(useWorkflowRunStore.getState().runs['run-1'].judge.status).toBe('completed');
  });
});
