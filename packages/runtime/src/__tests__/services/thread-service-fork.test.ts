import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tm: {
    getThread: vi.fn(),
    getThreadWithMessages: vi.fn(),
    createThread: vi.fn(async () => undefined),
    insertMessage: vi.fn(async () => 'msg-new'),
    insertToolCall: vi.fn(async () => 'tc-new'),
    updateToolCallOutput: vi.fn(async () => undefined),
    updateThread: vi.fn(async () => undefined),
  },
  projects: {
    resolveProjectPath: vi.fn(),
  },
  threadEventBus: {
    emit: vi.fn(),
  },
  getSessionMessages: vi.fn(),
  forkSession: vi.fn(),
  copyGitCheckpoint: vi.fn(async () => true),
}));

vi.mock('nanoid', () => ({ nanoid: () => 'fork-thread-id' }));

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

vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: mocks.threadEventBus,
}));

vi.mock('../../services/git-checkpoints.js', () => ({
  copyGitCheckpoint: mocks.copyGitCheckpoint,
}));

vi.mock('../../services/git-checkpoints.js', () => ({
  copyGitCheckpoint: mocks.copyGitCheckpoint,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionMessages: mocks.getSessionMessages,
  forkSession: mocks.forkSession,
}));

import { ok, err } from 'neverthrow';

import { forkThread } from '../../services/thread-service/fork.js';

const sourceThread = {
  id: 'src-1',
  userId: 'u-1',
  projectId: 'p-1',
  sessionId: 'sess-1',
  title: 'Original',
  mode: 'local',
  runtime: 'local',
  provider: 'claude',
  fileCheckpointingEnabled: 1,
  permissionMode: 'autoEdit',
  model: 'opus',
  branch: 'main',
  baseBranch: 'main',
  worktreePath: null,
};

describe('forkThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
    mocks.tm.getThread.mockResolvedValue(sourceThread);
    mocks.tm.getThreadWithMessages.mockResolvedValue({
      ...sourceThread,
      messages: [
        { id: 'm-1', role: 'user', content: 'Hello', toolCalls: [] },
        { id: 'm-2', role: 'assistant', content: 'Hi', toolCalls: [] },
      ],
    });
  });

  test('returns 404 when source thread is missing', async () => {
    mocks.tm.getThread.mockResolvedValue(undefined);

    const result = await forkThread({
      sourceThreadId: 'missing',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(404);
    }
  });

  test('returns 404 when user does not own the thread', async () => {
    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'other-user',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(404);
    }
  });

  test('forks a thread that has no provider session yet', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...sourceThread, sessionId: null });

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null, contextRecoveryReason: 'forked' }),
    );
  });

  test('returns 400 when fork point is not a user message', async () => {
    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-2',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('user message');
    }
  });

  test('returns 400 when project path cannot be resolved', async () => {
    mocks.projects.resolveProjectPath.mockResolvedValue(err(new Error('no path')));

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
    }
  });

  test('forks a claude thread natively without touching the SDK transcript', async () => {
    // Regression: the SDK looked for the transcript under the runtime's own
    // CLAUDE_CONFIG_DIR, not the thread profile's, and failed with
    // "Could not locate matching message in agent session transcript".
    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
      title: 'Branch A',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.getSessionMessages).not.toHaveBeenCalled();
    expect(mocks.forkSession).not.toHaveBeenCalled();
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fork-thread-id',
        sessionId: null,
        contextRecoveryReason: 'forked',
        parentThreadId: 'src-1',
        title: 'Branch A',
        status: 'idle',
      }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenCalledTimes(1);
    // The fork inherits the source's Git checkpoint so it can rewind to m-1.
    expect(mocks.copyGitCheckpoint).toHaveBeenCalledWith({
      cwd: '/repo',
      from: { threadId: 'src-1', messageId: 'm-1' },
      to: { threadId: 'fork-thread-id', messageId: 'msg-new' },
    });
    expect(mocks.tm.updateThread).toHaveBeenCalledWith('fork-thread-id', {
      fileCheckpointingEnabled: 1,
    });
    if (result.isOk()) expect(result.value.fileCheckpointingEnabled).toBe(1);
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:created',
      expect.objectContaining({ threadId: 'fork-thread-id' }),
    );
  });

  test('re-points the source Git checkpoints at the copied user messages', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...sourceThread, fileCheckpointingEnabled: 1 });
    mocks.tm.insertMessage.mockResolvedValueOnce('new-user-1');

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.copyGitCheckpoint).toHaveBeenCalledWith({
      cwd: '/repo',
      from: { threadId: 'src-1', messageId: 'm-1' },
      to: { threadId: 'fork-thread-id', messageId: 'new-user-1' },
    });
    expect(mocks.tm.updateThread).toHaveBeenCalledWith('fork-thread-id', {
      fileCheckpointingEnabled: 1,
    });
    if (result.isOk()) expect(result.value.fileCheckpointingEnabled).toBe(1);
  });

  test('keeps rewind disabled on the fork when no checkpoint could be copied', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...sourceThread, fileCheckpointingEnabled: 1 });
    mocks.copyGitCheckpoint.mockRejectedValueOnce(new Error('not a git repo'));

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateThread).not.toHaveBeenCalled();
  });

  test('returns 404 when fork message id is missing', async () => {
    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'missing',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(404);
      expect(result.error.message).toContain('Message not found');
    }
  });

  test('copies nested tool calls with remapped parent ids', async () => {
    mocks.tm.insertMessage.mockResolvedValueOnce('new-msg-1');
    mocks.tm.insertToolCall
      .mockResolvedValueOnce('new-tc-parent')
      .mockResolvedValueOnce('new-tc-child');
    mocks.tm.getThreadWithMessages.mockResolvedValue({
      ...sourceThread,
      messages: [
        {
          id: 'm-1',
          role: 'user',
          content: 'Hello',
          toolCalls: [
            {
              id: 'tc-parent',
              name: 'Bash',
              input: '{}',
              output: 'done',
              parentToolCallId: null,
            },
            {
              id: 'tc-child',
              name: 'Read',
              input: '{}',
              output: 'file',
              parentToolCallId: 'tc-parent',
            },
          ],
        },
      ],
    });

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.insertToolCall).toHaveBeenCalledTimes(2);
    expect(mocks.tm.insertToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ parentToolCallId: 'new-tc-parent' }),
    );
    expect(mocks.tm.updateToolCallOutput).toHaveBeenCalledTimes(2);
  });

  test.each(['codex', 'gemini', 'pi', 'custom'])(
    'forks a %s thread natively and marks it for context recovery',
    async (provider) => {
      mocks.tm.getThread.mockResolvedValue({ ...sourceThread, provider });
      // No checkpoint exists for the source message: the fork stays without
      // rewind support instead of pointing at a ref that is not there.
      mocks.copyGitCheckpoint.mockResolvedValueOnce(false);

      const result = await forkThread({
        sourceThreadId: 'src-1',
        messageId: 'm-1',
        userId: 'u-1',
      });

      expect(result.isOk()).toBe(true);
      expect(mocks.getSessionMessages).not.toHaveBeenCalled();
      expect(mocks.tm.updateThread).not.toHaveBeenCalled();
      expect(mocks.tm.createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          sessionId: null,
          contextRecoveryReason: 'forked',
          fileCheckpointingEnabled: 0,
          title: 'Fork: Original',
        }),
      );
    },
  );
});
