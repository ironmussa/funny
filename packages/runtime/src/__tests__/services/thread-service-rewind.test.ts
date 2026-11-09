import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tm: {
    getThread: vi.fn(),
    getThreadWithMessages: vi.fn(),
    deleteMessagesAfter: vi.fn(async () => 2),
    updateThread: vi.fn(async () => undefined),
  },
  projects: {
    resolveProjectPath: vi.fn(),
  },
  forkThread: vi.fn(),
  restoreGitCheckpoint: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/telemetry.js', () => ({
  metric: vi.fn(),
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../../services/thread-manager.js', () => mocks.tm);

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: mocks.projects }),
}));

vi.mock('../../services/thread-service/fork.js', () => ({
  forkThread: mocks.forkThread,
}));

vi.mock('../../services/git-checkpoints.js', () => ({
  restoreGitCheckpoint: mocks.restoreGitCheckpoint,
}));

import { ok, err } from 'neverthrow';

import { ThreadServiceError } from '../../services/thread-service/helpers.js';
import { rewindCode, forkAndRewind } from '../../services/thread-service/rewind.js';

const claudeThread = {
  id: 't-1',
  userId: 'u-1',
  projectId: 'p-1',
  sessionId: 'sess-1',
  provider: 'claude',
  fileCheckpointingEnabled: 1,
  status: 'idle',
  worktreePath: null,
};

const dbMessages = [
  { id: 'm-user-1', role: 'user', timestamp: '2024-01-01T00:00:00Z' },
  { id: 'm-asst-1', role: 'assistant', timestamp: '2024-01-01T00:01:00Z' },
  { id: 'm-user-2', role: 'user', timestamp: '2024-01-01T00:02:00Z' },
];

function seedAnchorMocks(thread: Record<string, unknown> = claudeThread) {
  mocks.tm.getThread.mockResolvedValue(thread);
  mocks.tm.getThreadWithMessages.mockResolvedValue({ ...thread, messages: dbMessages });
  mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
  mocks.restoreGitCheckpoint.mockResolvedValue({ canRewind: true, filesChanged: ['src/a.ts'] });
}

describe('rewindCode — validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
  });

  test('returns 404 when thread is missing', async () => {
    mocks.tm.getThread.mockResolvedValue(undefined);

    const result = await rewindCode({ threadId: 'missing', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('returns 404 when user does not own thread', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, userId: 'other' });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('returns 400 for a scratch thread (no git, no checkpoints)', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, isScratch: 1 });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
    expect(mocks.restoreGitCheckpoint).not.toHaveBeenCalled();
  });

  test('returns 400 when file checkpointing was disabled', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, fileCheckpointingEnabled: 0 });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('checkpointing');
    }
  });

  test('does not require a provider session: checkpoints are funny-native', async () => {
    seedAnchorMocks({ ...claudeThread, sessionId: null });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isOk()).toBe(true);
  });

  test('returns 409 when agent is still running', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, status: 'running' });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(409);
  });

  test('returns 404 when anchor message is missing', async () => {
    seedAnchorMocks();

    const result = await rewindCode({ threadId: 't-1', messageId: 'missing', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('returns 400 when anchor is not a user message', async () => {
    seedAnchorMocks();

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-asst-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
    expect(mocks.restoreGitCheckpoint).not.toHaveBeenCalled();
  });
});

describe('rewindCode — success and failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAnchorMocks();
  });

  test.each(['claude', 'codex', 'gemini'])(
    'restores the Git checkpoint for a %s thread, truncates DB messages and drops the session',
    async (provider) => {
      seedAnchorMocks({ ...claudeThread, provider });

      const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-2', userId: 'u-1' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.newSessionId).toBeNull();
        expect(result.value.deletedMessageCount).toBe(2);
        expect(result.value.rewind.filesChanged).toEqual(['src/a.ts']);
      }
      expect(mocks.restoreGitCheckpoint).toHaveBeenCalledWith({
        threadId: 't-1',
        messageId: 'm-user-2',
        cwd: '/repo',
      });
      expect(mocks.tm.deleteMessagesAfter).toHaveBeenCalledWith('t-1', 'm-user-2');
      expect(mocks.tm.updateThread).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({
          sessionId: null,
          contextRecoveryReason: 'rewound',
          fileCheckpointingEnabled: 1,
          status: 'idle',
        }),
      );
    },
  );

  test('restores inside the worktree when the thread has one', async () => {
    seedAnchorMocks({ ...claudeThread, worktreePath: '/repo/.worktrees/t-1' });

    await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(mocks.restoreGitCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo/.worktrees/t-1' }),
    );
  });

  test('returns 400 and does not truncate when the checkpoint is unavailable', async () => {
    mocks.restoreGitCheckpoint.mockResolvedValue({
      canRewind: false,
      filesChanged: [],
      error: 'No Git checkpoint exists for this message',
    });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-2', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('checkpoint');
    }
    expect(mocks.tm.deleteMessagesAfter).not.toHaveBeenCalled();
    expect(mocks.tm.updateThread).not.toHaveBeenCalled();
  });
});

describe('forkAndRewind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAnchorMocks();
    mocks.forkThread.mockResolvedValue(
      ok({
        id: 't-fork',
        sessionId: null,
        worktreePath: '/repo/.worktrees/t-fork',
      }),
    );
  });

  test("forks the thread then restores the source checkpoint in the fork's cwd", async () => {
    const result = await forkAndRewind({
      sourceThreadId: 't-1',
      messageId: 'm-user-1',
      userId: 'u-1',
      title: 'Rewound fork',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.thread.id).toBe('t-fork');
      expect(result.value.rewind.filesChanged).toEqual(['src/a.ts']);
    }
    expect(mocks.forkThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: 't-1',
        messageId: 'm-user-1',
        title: 'Rewound fork',
      }),
    );
    expect(mocks.restoreGitCheckpoint).toHaveBeenCalledWith({
      threadId: 't-1',
      messageId: 'm-user-1',
      cwd: '/repo/.worktrees/t-fork',
    });
    // The source transcript is left untouched.
    expect(mocks.tm.deleteMessagesAfter).not.toHaveBeenCalled();
  });

  test('works for Codex threads too', async () => {
    seedAnchorMocks({ ...claudeThread, provider: 'codex' });

    const result = await forkAndRewind({
      sourceThreadId: 't-1',
      messageId: 'm-user-1',
      userId: 'u-1',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.forkThread).toHaveBeenCalled();
  });

  test('validates before forking: a missing checkpoint flag never forks', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, fileCheckpointingEnabled: 0 });

    const result = await forkAndRewind({
      sourceThreadId: 't-1',
      messageId: 'm-user-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
    expect(mocks.forkThread).not.toHaveBeenCalled();
  });

  test('propagates forkThread errors', async () => {
    mocks.forkThread.mockResolvedValue(err(new ThreadServiceError('Fork failed', 500)));

    const result = await forkAndRewind({
      sourceThreadId: 't-1',
      messageId: 'm-user-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toBe('Fork failed');
  });

  test('returns 400 when the checkpoint cannot be restored after forking', async () => {
    mocks.restoreGitCheckpoint.mockResolvedValue({
      canRewind: false,
      filesChanged: [],
      error: 'Failed to restore Git checkpoint: boom',
    });

    const result = await forkAndRewind({
      sourceThreadId: 't-1',
      messageId: 'm-user-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
  });
});
