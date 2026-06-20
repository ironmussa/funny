import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tm: {
    getThread: vi.fn(),
    updateThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
  },
  projects: {
    getProject: vi.fn(),
    resolveProjectPath: vi.fn(),
  },
  messageQueue: {
    clearQueue: vi.fn(async () => undefined),
  },
  threadEventBus: {
    emit: vi.fn(),
  },
  isAgentRunning: vi.fn(() => false),
  stopAgent: vi.fn(async () => undefined),
  startAgent: vi.fn(async () => undefined),
  cleanupThreadState: vi.fn(),
  createWorktree: vi.fn(),
  setupWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  removeBranch: vi.fn(),
  getCurrentBranch: vi.fn(),
  git: vi.fn(),
  wsBroker: { emit: vi.fn(), emitToUser: vi.fn() },
  stopContainer: vi.fn(() => ({ match: (_ok: () => void) => _ok() })),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/thread-manager.js', () => mocks.tm);

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: mocks.projects,
    messageQueue: mocks.messageQueue,
  }),
}));

vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: mocks.threadEventBus,
}));

vi.mock('../../services/agent-runner-control.js', () => ({
  startAgent: mocks.startAgent,
  stopAgent: mocks.stopAgent,
  isAgentRunning: mocks.isAgentRunning,
  cleanupThreadState: mocks.cleanupThreadState,
}));

vi.mock('@funny/core/git', () => ({
  createWorktree: mocks.createWorktree,
  removeWorktree: mocks.removeWorktree,
  removeBranch: mocks.removeBranch,
  getCurrentBranch: mocks.getCurrentBranch,
  git: mocks.git,
}));

vi.mock('@funny/core/ports', () => ({
  setupWorktree: mocks.setupWorktree,
}));

vi.mock('../../services/command-runner.js', () => ({
  stopCommandsByCwd: vi.fn(async () => undefined),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: mocks.wsBroker,
}));

vi.mock('../../services/podman-service.js', () => ({
  stopContainer: mocks.stopContainer,
}));

import { ok, err } from 'neverthrow';

import {
  updateThread,
  deleteThread,
  convertToWorktree,
} from '../../services/thread-service/update.js';

const baseThread = {
  id: 't-1',
  userId: 'u-1',
  projectId: 'p-1',
  title: 'Old title',
  stage: 'backlog',
  status: 'completed',
  mode: 'local',
  provider: 'claude',
  worktreePath: null,
  branch: 'main',
  isScratch: 0,
};

describe('updateThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue({ id: 'p-1', path: '/repo' });
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
    mocks.tm.getThread.mockImplementation(async (id: string) =>
      id === 't-1' ? { ...baseThread } : undefined,
    );
  });

  test('returns 404 when thread is missing', async () => {
    mocks.tm.getThread.mockResolvedValue(undefined);

    const result = await updateThread({ threadId: 'missing', userId: 'u-1', title: 'X' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(404);
    }
  });

  test('updates title and emits stage-changed when stage moves', async () => {
    mocks.tm.getThread.mockImplementation(async () => ({
      ...baseThread,
      stage: 'backlog',
    }));

    const result = await updateThread({
      threadId: 't-1',
      userId: 'u-1',
      title: 'New title',
      stage: 'in_progress',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ title: 'New title', stage: 'in_progress' }),
    );
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:stage-changed',
      expect.objectContaining({
        threadId: 't-1',
        fromStage: 'backlog',
        toStage: 'in_progress',
      }),
    );
  });

  test('emits archived stage transition', async () => {
    const result = await updateThread({
      threadId: 't-1',
      userId: 'u-1',
      archived: true,
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ archived: 1 }),
    );
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:stage-changed',
      expect.objectContaining({ toStage: 'archived' }),
    );
  });
});

describe('deleteThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
  });

  test('returns 404 when thread is missing', async () => {
    mocks.tm.getThread.mockResolvedValue(undefined);

    const result = await deleteThread('missing');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(404);
    }
  });

  test('emits thread:deleted and clears queue for scratch threads', async () => {
    mocks.tm.getThread.mockResolvedValue({
      ...baseThread,
      isScratch: 1,
      projectId: '',
    });

    const result = await deleteThread('t-1');

    expect(result.isOk()).toBe(true);
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:deleted',
      expect.objectContaining({ threadId: 't-1', userId: 'u-1' }),
    );
    expect(mocks.messageQueue.clearQueue).toHaveBeenCalledWith('t-1');
    expect(mocks.cleanupThreadState).toHaveBeenCalledWith('t-1');
    expect(mocks.tm.deleteThread).toHaveBeenCalledWith('t-1');
  });

  test('stops running agent before delete', async () => {
    mocks.tm.getThread.mockResolvedValue(baseThread);
    mocks.isAgentRunning.mockReturnValue(true);

    const result = await deleteThread('t-1');

    expect(result.isOk()).toBe(true);
    expect(mocks.stopAgent).toHaveBeenCalledWith('t-1');
  });

  test('removes worktree and branch for worktree-mode threads', async () => {
    mocks.tm.getThread.mockResolvedValue({
      ...baseThread,
      mode: 'worktree',
      worktreePath: '/repo/.worktrees/t-1',
      branch: 'my-app/feature-t-1',
    });
    mocks.removeWorktree.mockReturnValue({ match: (_ok: () => void) => _ok() });
    mocks.removeBranch.mockReturnValue({ match: (_ok: () => void) => _ok() });

    const result = await deleteThread('t-1');

    expect(result.isOk()).toBe(true);
    expect(mocks.removeWorktree).toHaveBeenCalledWith('/repo', '/repo/.worktrees/t-1');
    expect(mocks.removeBranch).toHaveBeenCalledWith('/repo', 'my-app/feature-t-1');
  });
});

describe('updateThread — archive worktree cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue({ id: 'p-1', path: '/repo' });
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
    mocks.removeWorktree.mockReturnValue({ match: (_ok: () => void) => _ok() });
    mocks.removeBranch.mockReturnValue({ match: (_ok: () => void) => _ok() });
    mocks.tm.getThread.mockImplementation(async (id: string) =>
      id === 't-1'
        ? {
            ...baseThread,
            mode: 'worktree',
            worktreePath: '/repo/.worktrees/t-1',
            branch: 'my-app/feature-t-1',
          }
        : undefined,
    );
  });

  test('clears worktree and branch when archiving', async () => {
    const result = await updateThread({ threadId: 't-1', userId: 'u-1', archived: true });

    expect(result.isOk()).toBe(true);
    expect(mocks.removeWorktree).toHaveBeenCalledWith('/repo', '/repo/.worktrees/t-1');
    expect(mocks.removeBranch).toHaveBeenCalledWith('/repo', 'my-app/feature-t-1');
    expect(mocks.messageQueue.clearQueue).toHaveBeenCalledWith('t-1');
    expect(mocks.cleanupThreadState).toHaveBeenCalledWith('t-1');
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ archived: 1, worktreePath: null, branch: null }),
    );
  });
});

describe('updateThread — auto-start idle thread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue({
      id: 'p-1',
      path: '/repo',
      defaultModel: 'sonnet',
      defaultProvider: 'claude',
    });
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.createWorktree.mockResolvedValue(ok('/repo/.worktrees/t-1'));
    mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: [] }));
    mocks.git.mockResolvedValue(ok(undefined));
    mocks.tm.getThreadMessages.mockResolvedValue({
      messages: [{ id: 'draft-1', content: 'hello', images: null }],
      hasMore: false,
    });
  });

  test('starts agent when idle thread moves to in_progress (local mode)', async () => {
    mocks.tm.getThread.mockImplementation(async () => ({
      ...baseThread,
      status: 'idle',
      initialPrompt: 'Fix the bug',
      stage: 'backlog',
    }));

    const result = await updateThread({
      threadId: 't-1',
      userId: 'u-1',
      stage: 'in_progress',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.startAgent).toHaveBeenCalledWith(
      't-1',
      'Fix the bug',
      '/repo',
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      undefined,
      expect.any(String),
      undefined,
      true,
    );
  });

  test('marks thread failed when project path cannot be resolved', async () => {
    mocks.tm.getThread.mockImplementation(async () => ({
      ...baseThread,
      status: 'idle',
      initialPrompt: 'Fix the bug',
    }));
    mocks.projects.resolveProjectPath.mockResolvedValue(err(new Error('no path')));

    await updateThread({ threadId: 't-1', userId: 'u-1', stage: 'in_progress' });

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(mocks.startAgent).not.toHaveBeenCalled();
  });

  test('creates worktree in background when idle worktree thread has no path yet', async () => {
    mocks.tm.getThread.mockImplementation(async () => ({
      ...baseThread,
      status: 'idle',
      initialPrompt: 'Build feature',
      mode: 'worktree',
      branch: 'my-app/feature',
      baseBranch: 'main',
      worktreePath: null,
    }));

    await updateThread({ threadId: 't-1', userId: 'u-1', stage: 'in_progress' });

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ status: 'setting_up' }),
    );

    await vi.waitFor(() => {
      expect(mocks.createWorktree).toHaveBeenCalled();
      expect(mocks.startAgent).toHaveBeenCalledWith(
        't-1',
        'Build feature',
        '/repo/.worktrees/t-1',
        expect.any(String),
        expect.any(String),
        undefined,
        undefined,
        undefined,
        expect.any(String),
        undefined,
        true,
      );
    });
  });
});

describe('convertToWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue({ id: 'p-1', name: 'My App', path: '/repo' });
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.createWorktree.mockResolvedValue(ok('/repo/.worktrees/t-1'));
    mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: [] }));
    mocks.tm.getThread.mockImplementation(async (id: string) =>
      id === 't-1'
        ? { ...baseThread, title: 'My Thread', mode: 'local', worktreePath: null }
        : undefined,
    );
  });

  test('returns 404 when thread is missing', async () => {
    mocks.tm.getThread.mockResolvedValue(undefined);

    const result = await convertToWorktree('missing', 'u-1');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('returns 400 when thread is already in worktree mode', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...baseThread, mode: 'worktree' });

    const result = await convertToWorktree('t-1', 'u-1');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
  });

  test('returns 400 when thread already has a worktree path', async () => {
    mocks.tm.getThread.mockResolvedValue({
      ...baseThread,
      mode: 'local',
      worktreePath: '/repo/.worktrees/existing',
    });

    const result = await convertToWorktree('t-1', 'u-1');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
  });

  test('sets setting_up then completes worktree conversion in background', async () => {
    const result = await convertToWorktree('t-1', 'u-1', 'main');

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ status: 'setting_up' }),
    );

    await vi.waitFor(() => {
      expect(mocks.createWorktree).toHaveBeenCalledWith(
        '/repo',
        expect.stringContaining('my-app/my-thread'),
        'main',
        expect.any(Function),
      );
      expect(mocks.tm.updateThread).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({
          mode: 'worktree',
          worktreePath: '/repo/.worktrees/t-1',
          status: 'pending',
          sessionId: null,
          contextRecoveryReason: 'worktree-convert',
        }),
      );
      expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({ type: 'worktree:setup_complete' }),
      );
    });
  });

  test('marks thread failed when worktree creation fails', async () => {
    mocks.createWorktree.mockResolvedValue(err(new Error('git failed')));

    await convertToWorktree('t-1', 'u-1');

    await vi.waitFor(() => {
      expect(mocks.tm.updateThread).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  test('stops running agent before conversion', async () => {
    mocks.isAgentRunning.mockReturnValue(true);

    await convertToWorktree('t-1', 'u-1');

    expect(mocks.stopAgent).toHaveBeenCalledWith('t-1');
  });

  test('marks thread failed when background convert throws unexpectedly', async () => {
    mocks.setupWorktree.mockRejectedValue(new Error('unexpected'));

    await convertToWorktree('t-1', 'u-1');

    await vi.waitFor(() => {
      expect(mocks.tm.updateThread).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });
});

describe('updateThread — pinned and no-op paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue({ id: 'p-1', path: '/repo' });
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
    mocks.tm.getThread.mockImplementation(async () => ({ ...baseThread }));
  });

  test('updates pinned flag without stage transition', async () => {
    const result = await updateThread({ threadId: 't-1', userId: 'u-1', pinned: true });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateThread).toHaveBeenCalledWith('t-1', { pinned: 1 });
    expect(mocks.threadEventBus.emit).not.toHaveBeenCalled();
  });
});

describe('updateThread — idle branch checkout and failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue({
      id: 'p-1',
      path: '/repo',
      defaultModel: 'sonnet',
      defaultProvider: 'claude',
    });
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
    mocks.git.mockResolvedValue(ok(undefined));
    mocks.tm.getThreadMessages.mockResolvedValue({ messages: [], hasMore: false });
  });

  test('marks idle thread failed when baseBranch checkout fails', async () => {
    mocks.tm.getThread.mockImplementation(async () => ({
      ...baseThread,
      status: 'idle',
      initialPrompt: 'Work on feature branch',
      branch: 'main',
      baseBranch: 'feature/x',
      worktreePath: null,
    }));
    mocks.git
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err(new Error('branch missing')));

    await updateThread({ threadId: 't-1', userId: 'u-1', stage: 'in_progress' });

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(mocks.startAgent).not.toHaveBeenCalled();
  });

  test('marks idle thread failed when startAgent rejects', async () => {
    mocks.tm.getThread.mockImplementation(async () => ({
      ...baseThread,
      status: 'idle',
      initialPrompt: 'Go',
      worktreePath: '/repo/.worktrees/existing',
    }));
    mocks.startAgent.mockRejectedValueOnce(new Error('spawn failed'));

    await updateThread({ threadId: 't-1', userId: 'u-1', stage: 'in_progress' });
    await vi.waitFor(() => {
      expect(mocks.tm.updateThread).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  test('marks idle worktree thread failed when deferred createWorktree fails', async () => {
    mocks.tm.getThread.mockImplementation(async () => ({
      ...baseThread,
      status: 'idle',
      initialPrompt: 'Build',
      mode: 'worktree',
      branch: 'my-app/feature',
      worktreePath: null,
    }));
    mocks.createWorktree.mockResolvedValue(err(new Error('git failed')));

    await updateThread({ threadId: 't-1', userId: 'u-1', stage: 'in_progress' });

    await vi.waitFor(() => {
      expect(mocks.tm.updateThread).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({ status: 'failed' }),
      );
    });
    expect(mocks.startAgent).not.toHaveBeenCalled();
  });
});

describe('deleteThread — remote and error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
  });

  test('still deletes thread when stopAgent throws', async () => {
    mocks.tm.getThread.mockResolvedValue(baseThread);
    mocks.isAgentRunning.mockReturnValue(true);
    mocks.stopAgent.mockRejectedValue(new Error('kill failed'));

    const result = await deleteThread('t-1');

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.deleteThread).toHaveBeenCalledWith('t-1');
  });

  test('attempts to stop remote container on delete', async () => {
    mocks.tm.getThread.mockResolvedValue({
      ...baseThread,
      runtime: 'remote',
      containerName: 'funny-t-1',
    });
    mocks.projects.getProject.mockResolvedValue({
      id: 'p-1',
      launcherUrl: 'http://launcher:8080',
    });

    const result = await deleteThread('t-1');

    expect(result.isOk()).toBe(true);
    expect(mocks.stopContainer).toHaveBeenCalledWith({
      containerName: 'funny-t-1',
      launcherUrl: 'http://launcher:8080',
    });
  });
});
