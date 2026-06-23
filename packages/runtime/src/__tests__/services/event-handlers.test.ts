import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitGitStatusForThread: vi.fn(async () => undefined),
  threadEventBus: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../../utils/git-status-helpers.js', () => ({
  emitGitStatusForThread: mocks.emitGitStatusForThread,
}));

vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: mocks.threadEventBus,
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { agentCompletedGitStatusHandler } from '../../services/handlers/agent-completed-git-status-handler.js';
import { commentHandler } from '../../services/handlers/comment-handler.js';
import { gitCommitPersistenceHandler } from '../../services/handlers/git-event-persistence-handler.js';
import {
  clearGitStatusDebounce,
  gitStatusHandler,
} from '../../services/handlers/git-status-handler.js';
import { registerAllHandlers } from '../../services/handlers/handler-registry.js';
import { stageTransitionOnAgentStartHandler } from '../../services/handlers/stage-transition-on-agent-start-handler.js';
import { threadDeletedWsHandler } from '../../services/handlers/thread-deleted-ws-handler.js';
import { threadStageChangedWsHandler } from '../../services/handlers/thread-stage-changed-ws-handler.js';
import type { HandlerServiceContext } from '../../services/handlers/types.js';

const { emitGitStatusForThread, threadEventBus } = mocks;

function makeCtx(overrides: Partial<HandlerServiceContext> = {}): HandlerServiceContext {
  return {
    getThread: vi.fn(async () => undefined),
    getProject: vi.fn(async () => undefined),
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

describe('commentHandler', () => {
  test('inserts a system comment when agent completes', async () => {
    const ctx = makeCtx();
    await commentHandler.action(
      {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        worktreePath: null,
        cwd: '/tmp',
        status: 'completed',
        cost: 0.1234,
      },
      ctx,
    );

    expect(ctx.insertComment).toHaveBeenCalledWith({
      threadId: 't-1',
      userId: 'u-1',
      source: 'system',
      content: 'Agent completed. Cost: $0.1234',
    });
  });

  test('records stopped status without cost formatting', async () => {
    const ctx = makeCtx();
    await commentHandler.action(
      {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        worktreePath: null,
        cwd: '/tmp',
        status: 'stopped',
        cost: 0,
      },
      ctx,
    );

    expect(ctx.insertComment).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Agent stopped by user.' }),
    );
  });

  test('ignores non-terminal statuses', async () => {
    const ctx = makeCtx();
    await commentHandler.action(
      {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        worktreePath: null,
        cwd: '/tmp',
        status: 'running' as any,
        cost: 0,
      },
      ctx,
    );

    expect(ctx.insertComment).not.toHaveBeenCalled();
  });
});

describe('threadDeletedWsHandler', () => {
  test('forwards deletion to the owning user', () => {
    const ctx = makeCtx();
    threadDeletedWsHandler.action({ threadId: 't-1', projectId: 'p-1', userId: 'u-1' }, ctx);

    expect(ctx.emitToUser).toHaveBeenCalledWith('u-1', {
      type: 'thread:deleted',
      threadId: 't-1',
      data: { projectId: 'p-1' },
    });
  });
});

describe('threadStageChangedWsHandler', () => {
  test('broadcasts kanban stage changes', () => {
    const ctx = makeCtx();
    threadStageChangedWsHandler.action(
      {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        fromStage: 'backlog',
        toStage: 'in_progress',
        cwd: '/repo',
        worktreePath: null,
      },
      ctx,
    );

    expect(ctx.emitToUser).toHaveBeenCalledWith('u-1', {
      type: 'thread:stage-changed',
      threadId: 't-1',
      data: {
        fromStage: 'backlog',
        toStage: 'in_progress',
        projectId: 'p-1',
      },
    });
  });
});

describe('gitCommitPersistenceHandler', () => {
  test('persists commit events and broadcasts thread:event', async () => {
    const ctx = makeCtx();
    await gitCommitPersistenceHandler.action(
      {
        threadId: 't-1',
        userId: 'u-1',
        projectId: 'p-1',
        cwd: '/repo',
        message: 'fix: bug',
        amend: false,
      },
      ctx,
    );

    expect(ctx.saveThreadEvent).toHaveBeenCalledWith(
      't-1',
      'git:commit',
      expect.objectContaining({ message: 'fix: bug' }),
    );
    expect(ctx.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'thread:event',
        threadId: 't-1',
      }),
    );
  });
});

describe('stageTransitionOnAgentStartHandler', () => {
  test('filter accepts backlog/planning/review stages only', async () => {
    const ctx = makeCtx({
      getThread: vi.fn(async () => ({
        id: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        stage: 'backlog',
      })),
    });

    expect(
      await stageTransitionOnAgentStartHandler.filter!(
        { threadId: 't-1', userId: 'u-1', projectId: 'p-1' },
        ctx,
      ),
    ).toBe(true);

    (ctx.getThread as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't-1',
      projectId: 'p-1',
      userId: 'u-1',
      stage: 'in_progress',
    });
    expect(
      await stageTransitionOnAgentStartHandler.filter!(
        { threadId: 't-1', userId: 'u-1', projectId: 'p-1' },
        ctx,
      ),
    ).toBe(false);
  });

  test('moves thread to in_progress and notifies client', async () => {
    const ctx = makeCtx({
      getThread: vi.fn(async () => ({
        id: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        stage: 'planning',
      })),
    });

    await stageTransitionOnAgentStartHandler.action(
      { threadId: 't-1', userId: 'u-1', projectId: 'p-1' },
      ctx,
    );

    expect(ctx.updateThread).toHaveBeenCalledWith('t-1', { stage: 'in_progress' });
    expect(ctx.emitToUser).toHaveBeenCalledWith('u-1', {
      type: 'agent:status',
      threadId: 't-1',
      data: { status: 'running', stage: 'in_progress' },
    });
  });
});

describe('agentCompletedGitStatusHandler', () => {
  test('refreshes git status after completion', async () => {
    const ctx = makeCtx();
    const event = {
      threadId: 't-1',
      projectId: 'p-1',
      userId: 'u-1',
      worktreePath: null,
      cwd: '/tmp/repo',
      status: 'completed' as const,
      cost: 0,
    };

    await agentCompletedGitStatusHandler.action(event, ctx);

    expect(emitGitStatusForThread).toHaveBeenCalledWith(event, ctx);
  });
});

describe('gitStatusHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    emitGitStatusForThread.mockClear();
  });

  afterEach(() => {
    clearGitStatusDebounce('t-1');
    vi.useRealTimers();
  });

  test('debounces git status emission', async () => {
    const ctx = makeCtx();

    gitStatusHandler.action(
      { threadId: 't-1', userId: 'u-1', projectId: 'p-1', cwd: '/tmp', toolName: 'Write' },
      ctx,
    );
    gitStatusHandler.action(
      { threadId: 't-1', userId: 'u-1', projectId: 'p-1', cwd: '/tmp', toolName: 'Write' },
      ctx,
    );

    expect(emitGitStatusForThread).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(emitGitStatusForThread).toHaveBeenCalledTimes(1);
    expect(emitGitStatusForThread).toHaveBeenCalledWith(
      expect.objectContaining({ detectBranchDrift: false }),
      ctx,
    );
  });

  test('enables branch drift detection for Bash tool calls', async () => {
    const ctx = makeCtx();

    gitStatusHandler.action(
      { threadId: 't-1', userId: 'u-1', projectId: 'p-1', cwd: '/tmp', toolName: 'Bash' },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(emitGitStatusForThread).toHaveBeenCalledWith(
      expect.objectContaining({ detectBranchDrift: true }),
      ctx,
    );
  });
});

describe('registerAllHandlers', () => {
  beforeEach(() => {
    threadEventBus.on.mockClear();
  });

  test('registers every handler on the event bus', () => {
    registerAllHandlers(makeCtx());

    expect(threadEventBus.on).toHaveBeenCalled();
    expect(threadEventBus.on.mock.calls.length).toBeGreaterThan(20);
  });

  test('swallows handler errors without rethrowing', async () => {
    const ctx = makeCtx({
      insertComment: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    registerAllHandlers(ctx);

    const commentRegistration = threadEventBus.on.mock.calls.find(
      ([event]) => event === 'agent:completed',
    );
    expect(commentRegistration).toBeDefined();

    const wrappedListener = commentRegistration![1] as (payload: unknown) => Promise<void>;
    await expect(
      wrappedListener({
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        worktreePath: null,
        cwd: '/tmp',
        status: 'completed',
        cost: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
