import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getPipelineForProject: vi.fn(),
  startPipelineRun: vi.fn(async () => undefined),
  isWorkflowActive: vi.fn(() => false),
  metric: vi.fn(),
  startSpan: vi.fn(() => ({ end: vi.fn() })),
  getThreadTrace: vi.fn(() => undefined),
}));

vi.mock('../../services/git-watcher-service.js', () => ({
  startWatching: mocks.startWatching,
  stopWatching: mocks.stopWatching,
}));

vi.mock('../../services/pipeline-manager.js', () => ({
  getPipelineForProject: mocks.getPipelineForProject,
  startPipelineRun: mocks.startPipelineRun,
}));

vi.mock('../../services/git-workflow-service.js', () => ({
  isWorkflowActive: mocks.isWorkflowActive,
}));

vi.mock('../../lib/telemetry.js', () => ({
  metric: mocks.metric,
  startSpan: mocks.startSpan,
  getThreadTrace: mocks.getThreadTrace,
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  gitPushPersistenceHandler,
  gitMergePersistenceHandler,
  gitStagePersistenceHandler,
  gitUnstagePersistenceHandler,
  gitRevertPersistenceHandler,
  gitPullPersistenceHandler,
  gitStashPersistenceHandler,
  gitStashPopPersistenceHandler,
  gitResetSoftPersistenceHandler,
} from '../../services/handlers/git-event-persistence-handler.js';
import {
  gitWatcherStartHandler,
  gitWatcherStopHandler,
  gitWatcherStartOnAgentStartHandler,
  gitWatcherStopOnAgentCompletedHandler,
} from '../../services/handlers/git-watcher-lifecycle-handler.js';
import { pipelineTriggerHandler } from '../../services/handlers/pipeline-trigger-handler.js';
import {
  gitCommitTelemetryHandler,
  gitPushTelemetryHandler,
  gitMergeTelemetryHandler,
  gitPullTelemetryHandler,
  gitStageTelemetryHandler,
  gitUnstageTelemetryHandler,
  gitRevertTelemetryHandler,
  gitStashTelemetryHandler,
  gitStashPopTelemetryHandler,
  gitResetSoftTelemetryHandler,
} from '../../services/handlers/telemetry-handler.js';
import type { HandlerServiceContext } from '../../services/handlers/types.js';

function makeCtx(overrides: Partial<HandlerServiceContext> = {}): HandlerServiceContext {
  return {
    getThread: vi.fn(async () => undefined),
    getProject: vi.fn(async () => ({ id: 'p-1', path: '/repo' })),
    dequeueMessage: vi.fn(async () => null),
    enqueueMessage: vi.fn(async () => ({})),
    queueCount: vi.fn(async () => 0),
    peekMessage: vi.fn(async () => null),
    startAgent: vi.fn(async () => undefined),
    emitToUser: vi.fn(),
    broadcast: vi.fn(),
    log: vi.fn(),
    updateThread: vi.fn(async () => undefined),
    insertComment: vi.fn(async () => undefined),
    getGitStatusSummary: vi.fn() as any,
    deriveGitSyncState: vi.fn() as any,
    invalidateGitStatusCache: vi.fn(),
    saveThreadEvent: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('gitWatcherLifecycleHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('starts watching on thread:created when project exists', async () => {
    const ctx = makeCtx();
    await gitWatcherStartHandler.action(
      {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        cwd: '/repo',
        worktreePath: '/repo/.worktrees/t-1',
        stage: 'in_progress',
        status: 'pending',
      },
      ctx,
    );

    expect(mocks.startWatching).toHaveBeenCalledWith(
      'p-1',
      '/repo',
      't-1',
      'u-1',
      '/repo/.worktrees/t-1',
    );
  });

  test('skips watch start when project is missing', async () => {
    const ctx = makeCtx({ getProject: vi.fn(async () => undefined) });
    await gitWatcherStartHandler.action(
      {
        threadId: 't-1',
        projectId: 'missing',
        userId: 'u-1',
        cwd: '/repo',
        worktreePath: null,
        stage: 'in_progress',
        status: 'pending',
      },
      ctx,
    );

    expect(mocks.startWatching).not.toHaveBeenCalled();
  });

  test('stops watching on thread:deleted', () => {
    gitWatcherStopHandler.action({ threadId: 't-1', projectId: 'p-1', userId: 'u-1' }, makeCtx());
    expect(mocks.stopWatching).toHaveBeenCalledWith('p-1', 't-1');
  });

  test('starts watching on agent:started', async () => {
    const ctx = makeCtx();
    await gitWatcherStartOnAgentStartHandler.action(
      {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        cwd: '/repo',
        worktreePath: null,
      },
      ctx,
    );

    expect(mocks.startWatching).toHaveBeenCalledWith('p-1', '/repo', 't-1', 'u-1', null);
  });

  test('stops watching on agent:completed except waiting status', () => {
    gitWatcherStopOnAgentCompletedHandler.action(
      {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        worktreePath: null,
        cwd: '/repo',
        status: 'completed',
        cost: 0,
      },
      makeCtx(),
    );
    expect(mocks.stopWatching).toHaveBeenCalledWith('p-1', 't-1');

    mocks.stopWatching.mockClear();
    gitWatcherStopOnAgentCompletedHandler.action(
      {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        worktreePath: null,
        cwd: '/repo',
        status: 'waiting' as any,
        cost: 0,
      },
      makeCtx(),
    );
    expect(mocks.stopWatching).not.toHaveBeenCalled();
  });
});

describe('gitPersistenceHandlers', () => {
  test('persists push events', async () => {
    const ctx = makeCtx();
    await gitPushPersistenceHandler.action(
      { threadId: 't-1', userId: 'u-1', projectId: 'p-1', cwd: '/repo', workflowId: 'wf-1' },
      ctx,
    );

    expect(ctx.saveThreadEvent).toHaveBeenCalledWith('t-1', 'git:push', expect.any(Object));
    expect(ctx.emitToUser).toHaveBeenCalled();
  });

  test('persists merge events', async () => {
    const ctx = makeCtx();
    await gitMergePersistenceHandler.action(
      {
        threadId: 't-1',
        userId: 'u-1',
        projectId: 'p-1',
        cwd: '/repo',
        sourceBranch: 'feature',
        targetBranch: 'main',
        output: 'merged',
      },
      ctx,
    );

    expect(ctx.saveThreadEvent).toHaveBeenCalledWith(
      't-1',
      'git:merge',
      expect.objectContaining({ sourceBranch: 'feature' }),
    );
  });

  test('persists stage/unstage/revert events', async () => {
    const ctx = makeCtx();
    const base = {
      threadId: 't-1',
      userId: 'u-1',
      projectId: 'p-1',
      cwd: '/repo',
      paths: ['a.ts'],
      workflowId: 'wf-1',
    };

    await gitStagePersistenceHandler.action(base, ctx);
    await gitUnstagePersistenceHandler.action(base, ctx);
    await gitRevertPersistenceHandler.action(base, ctx);

    expect(ctx.saveThreadEvent).toHaveBeenCalledWith('t-1', 'git:stage', expect.any(Object));
    expect(ctx.saveThreadEvent).toHaveBeenCalledWith('t-1', 'git:unstage', expect.any(Object));
    expect(ctx.saveThreadEvent).toHaveBeenCalledWith('t-1', 'git:revert', expect.any(Object));
  });

  test('persists pull/stash/reset-soft events', async () => {
    const ctx = makeCtx();
    const base = { threadId: 't-1', userId: 'u-1', projectId: 'p-1', cwd: '/repo', output: 'ok' };

    await gitPullPersistenceHandler.action(base, ctx);
    await gitStashPersistenceHandler.action(base, ctx);
    await gitStashPopPersistenceHandler.action(base, ctx);
    await gitResetSoftPersistenceHandler.action(base, ctx);

    expect(ctx.saveThreadEvent).toHaveBeenCalledWith('t-1', 'git:pull', expect.any(Object));
    expect(ctx.saveThreadEvent).toHaveBeenCalledWith('t-1', 'git:stash', expect.any(Object));
    expect(ctx.saveThreadEvent).toHaveBeenCalledWith('t-1', 'git:stash-pop', expect.any(Object));
    expect(ctx.saveThreadEvent).toHaveBeenCalledWith('t-1', 'git:reset-soft', expect.any(Object));
  });
});

describe('pipelineTriggerHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isWorkflowActive.mockReturnValue(false);
  });

  test('starts pipeline run when project has a pipeline configured', async () => {
    mocks.getPipelineForProject.mockResolvedValue({ id: 'pipe-1', name: 'review' });

    await pipelineTriggerHandler.action(
      {
        threadId: 't-1',
        userId: 'u-1',
        projectId: 'p-1',
        cwd: '/repo',
        message: 'fix',
        amend: false,
        commitSha: 'abc123',
      },
      makeCtx(),
    );

    expect(mocks.startPipelineRun).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 't-1',
        commitSha: 'abc123',
        pipeline: { id: 'pipe-1', name: 'review' },
      }),
    );
  });

  test('skips when no pipeline is configured', async () => {
    mocks.getPipelineForProject.mockResolvedValue(null);

    await pipelineTriggerHandler.action(
      {
        threadId: 't-1',
        userId: 'u-1',
        projectId: 'p-1',
        cwd: '/repo',
        message: 'fix',
        amend: false,
        commitSha: 'abc123',
      },
      makeCtx(),
    );

    expect(mocks.startPipelineRun).not.toHaveBeenCalled();
  });

  test('skips when workflow is already active', async () => {
    mocks.getPipelineForProject.mockResolvedValue({ id: 'pipe-1' });
    mocks.isWorkflowActive.mockReturnValue(true);

    await pipelineTriggerHandler.action(
      {
        threadId: 't-1',
        userId: 'u-1',
        projectId: 'p-1',
        cwd: '/repo',
        message: 'fix',
        amend: false,
        commitSha: 'abc123',
        isPipelineCommit: false,
      },
      makeCtx(),
    );

    expect(mocks.startPipelineRun).not.toHaveBeenCalled();
  });
});

describe('gitTelemetryHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('records commit/push/merge/pull spans and metrics', () => {
    gitCommitTelemetryHandler.action(
      {
        threadId: 't-1',
        userId: 'u-1',
        projectId: 'p-1',
        cwd: '/repo',
        message: 'fix',
        amend: true,
      },
      makeCtx(),
    );
    gitPushTelemetryHandler.action(
      { threadId: 't-1', userId: 'u-1', projectId: 'p-1', cwd: '/repo' },
      makeCtx(),
    );
    gitMergeTelemetryHandler.action(
      {
        threadId: 't-1',
        userId: 'u-1',
        projectId: 'p-1',
        cwd: '/repo',
        sourceBranch: 'a',
        targetBranch: 'b',
        output: '',
      },
      makeCtx(),
    );
    gitPullTelemetryHandler.action(
      { threadId: 't-1', userId: 'u-1', projectId: 'p-1', cwd: '/repo', output: '' },
      makeCtx(),
    );

    expect(mocks.startSpan).toHaveBeenCalled();
    expect(mocks.metric).toHaveBeenCalled();
  });

  test('records stage/unstage/revert file-count metrics', () => {
    const base = {
      threadId: 't-1',
      userId: 'u-1',
      projectId: 'p-1',
      cwd: '/repo',
      paths: ['a.ts', 'b.ts'],
    };

    gitStageTelemetryHandler.action(base, makeCtx());
    gitUnstageTelemetryHandler.action(base, makeCtx());
    gitRevertTelemetryHandler.action(base, makeCtx());

    expect(mocks.metric).toHaveBeenCalledWith(
      'git.operations',
      1,
      expect.objectContaining({ attributes: expect.objectContaining({ fileCount: '2' }) }),
    );
  });

  test('records stash and reset-soft metrics', () => {
    const ctx = makeCtx();
    const base = { threadId: 't-1', userId: 'u-1', projectId: 'p-1', cwd: '/repo', output: '' };

    gitStashTelemetryHandler.action(base, ctx);
    gitStashPopTelemetryHandler.action(base, ctx);
    gitResetSoftTelemetryHandler.action(base, ctx);

    expect(mocks.metric).toHaveBeenCalledTimes(3);
  });
});
