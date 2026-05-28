import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tm: {
    getThread: vi.fn(),
    getThreadWithMessages: vi.fn(),
    createThread: vi.fn(async () => undefined),
    insertMessage: vi.fn(async () => 'msg-new'),
    insertToolCall: vi.fn(async () => 'tc-new'),
    updateToolCallOutput: vi.fn(async () => undefined),
  },
  projects: {
    resolveProjectPath: vi.fn(),
  },
  threadEventBus: {
    emit: vi.fn(),
  },
  getSessionMessages: vi.fn(),
  forkSession: vi.fn(),
  forkAcpSession: vi.fn(),
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

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionMessages: mocks.getSessionMessages,
  forkSession: mocks.forkSession,
}));

vi.mock('@funny/core/agents', () => ({
  forkAcpSession: mocks.forkAcpSession,
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

  test('returns 400 when thread has no session', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...sourceThread, sessionId: null });

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('no session');
    }
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

  test('forks claude session and copies message prefix', async () => {
    mocks.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'sdk-u-1', message: { content: 'Hello' } },
    ]);
    mocks.forkSession.mockResolvedValue({ sessionId: 'sess-fork' });

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
      title: 'Branch A',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.forkSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ upToMessageId: 'sdk-u-1', title: 'Branch A' }),
    );
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fork-thread-id',
        sessionId: 'sess-fork',
        parentThreadId: 'src-1',
        title: 'Branch A',
        status: 'idle',
      }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenCalledTimes(1);
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:created',
      expect.objectContaining({ threadId: 'fork-thread-id' }),
    );
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

  test('returns 500 when SDK transcript cannot be read', async () => {
    mocks.getSessionMessages.mockRejectedValue(new Error('ENOENT'));

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(500);
      expect(result.error.message).toContain('transcript');
    }
  });

  test('returns 500 when SDK transcript has no matching user message', async () => {
    mocks.getSessionMessages.mockResolvedValue([
      { type: 'assistant', uuid: 'sdk-a-1', message: { content: 'Hi' } },
    ]);

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(500);
    }
  });

  test('returns 500 when forkSession throws', async () => {
    mocks.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'sdk-u-1', message: { content: 'Hello' } },
    ]);
    mocks.forkSession.mockRejectedValue(new Error('fork failed'));

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(500);
      expect(result.error.message).toContain('Failed to fork agent session');
    }
  });

  test('copies nested tool calls with remapped parent ids', async () => {
    mocks.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'sdk-u-1', message: { content: 'Hello' } },
    ]);
    mocks.forkSession.mockResolvedValue({ sessionId: 'sess-fork' });
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

  test('uses ACP fork for codex provider when available', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...sourceThread, provider: 'codex' });
    mocks.forkAcpSession.mockResolvedValue({ ok: true, newSessionId: 'acp-sess' });

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.forkAcpSession).toHaveBeenCalled();
    expect(mocks.getSessionMessages).not.toHaveBeenCalled();
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'acp-sess', fileCheckpointingEnabled: 0 }),
    );
  });

  test('falls back to DB-only fork when ACP fork is unavailable', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...sourceThread, provider: 'gemini' });
    mocks.forkAcpSession.mockResolvedValue({
      ok: false,
      reason: 'unsupported',
      message: 'not advertised',
    });

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null, fileCheckpointingEnabled: 0 }),
    );
  });

  test('copies DB messages only for providers without native fork', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...sourceThread, provider: 'custom' });

    const result = await forkThread({
      sourceThreadId: 'src-1',
      messageId: 'm-1',
      userId: 'u-1',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.getSessionMessages).not.toHaveBeenCalled();
    expect(mocks.forkAcpSession).not.toHaveBeenCalled();
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null, title: 'Fork: Original' }),
    );
  });
});
