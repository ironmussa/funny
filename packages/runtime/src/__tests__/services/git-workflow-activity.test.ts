import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * A thread's git workflow is tracked as a `git.workflow` activity
 * (track-background-activities): a rejected push ends `failed` with git's
 * message and a created PR ends `succeeded` with its URL.
 */

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  sendRemoteData: vi.fn(async (_type: string, _payload: Record<string, any>) => ({ ok: true })),
}));

vi.mock('@funny/pipelines', () => ({ runPipeline: mocks.runPipeline }));
vi.mock('../../services/git-pipelines.js', () => ({
  getActionPipeline: () => ({ nodes: [] }),
  deriveSteps: () => [{ id: 'push', label: 'Pushing to origin', status: 'pending' }],
}));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));
vi.mock('../../services/pipeline-manager.js', () => ({ getPipelineForProject: async () => null }));
vi.mock('../../services/project-hooks-service.js', () => ({ listHooks: () => [] }));
vi.mock('../../services/workflow-event-helpers.js', () => ({ emitWorkflowEvent: vi.fn() }));
vi.mock('../../services/remote-data-channel.js', () => ({ sendRemoteData: mocks.sendRemoteData }));

import { executeWorkflow } from '../../services/git-workflow-service.js';

const reports = (type: string) =>
  mocks.sendRemoteData.mock.calls.filter(([t]) => t === type).map(([, p]) => p);

const terminal = () =>
  vi.waitFor(() => {
    const end = reports('data:activity_update').find((p) => p.patch.status);
    expect(end).toBeDefined();
    return end!;
  });

function run(action: 'push' | 'create-pr', contextId: string) {
  return executeWorkflow({
    contextId,
    threadId: contextId,
    projectId: 'p1',
    userId: 'u1',
    cwd: '/tmp',
    action,
  });
}

describe('git workflow activity', () => {
  beforeEach(() => {
    mocks.sendRemoteData.mockClear();
    mocks.runPipeline.mockReset();
  });

  test('a rejected push ends failed with git message', async () => {
    mocks.runPipeline.mockImplementation(async (_p: unknown, ctx: any) => {
      ctx.setStep('push', { status: 'running' });
      ctx.setStep('push', { status: 'failed', error: '! [rejected] (non-fast-forward)' });
      return { outcome: 'failed', ctx, iterations: 1 };
    });

    const { workflowId } = run('push', 'thread-push');
    const end = await terminal();

    expect(reports('data:activity_start')[0]).toMatchObject({
      id: workflowId,
      kind: 'git.workflow',
      threadId: 'thread-push',
      projectId: 'p1',
      input: { action: 'push' },
    });
    expect(reports('data:activity_update')[0].patch).toEqual({ step: 'Pushing to origin' });
    expect(end).toEqual({
      id: workflowId,
      patch: { status: 'failed', error: '! [rejected] (non-fast-forward)' },
    });
  });

  test('a created PR ends succeeded with its URL', async () => {
    mocks.runPipeline.mockImplementation(async (_p: unknown, ctx: any) => ({
      outcome: 'completed',
      ctx: { ...ctx, prUrl: 'https://github.com/o/r/pull/9' },
      iterations: 1,
    }));

    run('create-pr', 'thread-pr');
    const end = await terminal();

    expect(end.patch).toEqual({
      status: 'succeeded',
      resultRef: { prUrl: 'https://github.com/o/r/pull/9' },
    });
  });
});
