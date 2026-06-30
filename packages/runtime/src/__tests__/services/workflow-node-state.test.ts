import { beforeEach, describe, expect, test, vi } from 'vitest';

const { emitToUser } = vi.hoisted(() => ({
  emitToUser: vi.fn(),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: {
    emitToUser,
  },
}));

import { RuntimeProgressReporter } from '../../services/pipeline-adapter.js';

describe('RuntimeProgressReporter workflow node state', () => {
  beforeEach(() => {
    emitToUser.mockReset();
  });

  test('emits node-level workflow state updates', () => {
    const reporter = new RuntimeProgressReporter({
      userId: 'user-1',
      threadId: 'thread-1',
      runId: 'run-1',
      workflowName: 'fusion',
    });

    reporter.onStepProgress('proposer-a', { status: 'running' });
    reporter.onStepProgress('proposer-a', { status: 'completed' });

    expect(emitToUser).toHaveBeenNthCalledWith(1, 'user-1', {
      type: 'workflow:node_state',
      threadId: 'thread-1',
      data: {
        runId: 'run-1',
        workflowName: 'fusion',
        nodeId: 'proposer-a',
        status: 'running',
        message: undefined,
        metadata: undefined,
      },
    });
    expect(emitToUser).toHaveBeenNthCalledWith(
      2,
      'user-1',
      expect.objectContaining({
        data: expect.objectContaining({ nodeId: 'proposer-a', status: 'completed' }),
      }),
    );
  });

  test('emits skipped, failed, and repeated loop node states', () => {
    const reporter = new RuntimeProgressReporter({
      userId: 'user-1',
      threadId: 'thread-1',
      runId: 'run-1',
      workflowName: 'review-loop',
    });

    reporter.onStepProgress('optional', { status: 'skipped' });
    reporter.onStepProgress('review', { status: 'running', metadata: { iteration: 1 } });
    reporter.onStepProgress('review', { status: 'completed', metadata: { iteration: 1 } });
    reporter.onStepProgress('review', { status: 'running', metadata: { iteration: 2 } });
    reporter.onStepProgress('fix', { status: 'failed', error: 'failed' });

    expect(emitToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        data: expect.objectContaining({ nodeId: 'optional', status: 'skipped' }),
      }),
    );
    expect(
      emitToUser.mock.calls.filter(([, event]) => event.data.nodeId === 'review'),
    ).toHaveLength(3);
    expect(emitToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        data: expect.objectContaining({ nodeId: 'fix', status: 'failed', message: 'failed' }),
      }),
    );
  });

  test('maps approval metadata to waiting_approval state', () => {
    const reporter = new RuntimeProgressReporter({
      userId: 'user-1',
      threadId: 'thread-1',
      runId: 'run-1',
      workflowName: 'release',
    });

    reporter.onStepProgress('approval', {
      status: 'running',
      metadata: { workflowStatus: 'waiting_approval' },
    });

    expect(emitToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'workflow:node_state',
        data: expect.objectContaining({
          nodeId: 'approval',
          status: 'waiting_approval',
        }),
      }),
    );
  });
});
