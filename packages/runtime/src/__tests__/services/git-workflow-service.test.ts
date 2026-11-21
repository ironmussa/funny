import { describe, expect, test, vi, mock } from 'bun:test';

import { waitFor } from '@funny/test-kit';

const mocks = (() => ({
  emitToUser: vi.fn(),
  getPipelineForProject: vi.fn(),
}))();

mock.module('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: mocks.emitToUser } }));
mock.module('../../services/pipeline-manager.js', () => ({
  getPipelineForProject: mocks.getPipelineForProject,
}));
mock.module('../../services/project-hooks-service.js', () => ({ listHooks: () => [] }));
mock.module('../../services/workflow-event-helpers.js', () => ({ emitWorkflowEvent: vi.fn() }));

import { executeWorkflow } from '../../services/git-workflow-service.js';

describe('executeWorkflow', () => {
  test('a workflow whose setup fails tells the client it failed', async () => {
    mocks.getPipelineForProject.mockRejectedValue(new Error('db down'));

    const { workflowId } = executeWorkflow({
      contextId: 'thread-1',
      threadId: 'thread-1',
      projectId: 'p1',
      userId: 'u1',
      cwd: '/tmp',
      action: 'push',
    });

    // Without this the client's buttons waited for an end that never came.
    await waitFor(() =>
      expect(mocks.emitToUser).toHaveBeenCalledWith('u1', {
        type: 'git:workflow_progress',
        threadId: 'thread-1',
        data: expect.objectContaining({ workflowId, status: 'failed', action: 'push' }),
      }),
    );
  });
});
