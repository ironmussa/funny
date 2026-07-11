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
  getSessionMessages: vi.fn(),
  forkSession: vi.fn(),
  query: vi.fn(),
  forkThread: vi.fn(),
  rewindFiles: vi.fn(),
  restoreCodexCheckpoint: vi.fn(),
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

vi.mock('../../services/codex-git-checkpoints.js', () => ({
  restoreCodexCheckpoint: mocks.restoreCodexCheckpoint,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionMessages: mocks.getSessionMessages,
  forkSession: mocks.forkSession,
  query: mocks.query,
}));

vi.mock('@funny/core/agents', () => ({
  resolveSDKCli: () => ({ path: '/bin/claude', kind: 'binary' }),
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

function seedAnchorMocks() {
  mocks.tm.getThread.mockResolvedValue(claudeThread);
  mocks.tm.getThreadWithMessages.mockResolvedValue({
    ...claudeThread,
    messages: dbMessages,
  });
  mocks.projects.resolveProjectPath.mockResolvedValue(ok('/repo'));
  mocks.getSessionMessages.mockResolvedValue([
    { type: 'user', uuid: 'sdk-uuid-0', message: { content: 'first' } },
    { type: 'user', uuid: 'sdk-uuid-1', message: { content: 'second' } },
  ]);
  mocks.rewindFiles.mockResolvedValue({ canRewind: true, filesChanged: ['src/a.ts'] });
  mocks.query.mockImplementation(() => ({
    rewindFiles: mocks.rewindFiles,
    close: vi.fn(),
  }));
  mocks.forkSession.mockResolvedValue({ sessionId: 'sess-forked' });
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

  test('returns 400 for a provider without rewind support', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, provider: 'gemini' });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
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

  test('returns 400 when thread has no session', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, sessionId: null });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
  });

  test('returns 409 when agent is still running', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, status: 'running' });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(409);
  });

  test('returns 404 when anchor message is missing', async () => {
    seedAnchorMocks();
    mocks.tm.getThreadWithMessages.mockResolvedValue({ ...claudeThread, messages: dbMessages });

    const result = await rewindCode({ threadId: 't-1', messageId: 'missing', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('returns 400 when anchor is not a user message', async () => {
    seedAnchorMocks();

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-asst-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
  });
});

describe('rewindCode — success and failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAnchorMocks();
  });

  test('rewinds files, forks session, and truncates DB messages', async () => {
    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-2', userId: 'u-1' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.newSessionId).toBe('sess-forked');
      expect(result.value.deletedMessageCount).toBe(2);
      expect(result.value.rewind.filesChanged).toEqual(['src/a.ts']);
    }
    expect(mocks.rewindFiles).toHaveBeenCalledWith('sdk-uuid-1');
    expect(mocks.forkSession).toHaveBeenCalledWith('sess-1', {
      upToMessageId: 'sdk-uuid-1',
      dir: '/repo',
    });
    expect(mocks.tm.deleteMessagesAfter).toHaveBeenCalledWith('t-1', 'm-user-2');
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({
        sessionId: 'sess-forked',
        fileCheckpointingEnabled: 1,
        status: 'idle',
      }),
    );
  });

  test('returns 400 when SDK reports canRewind=false', async () => {
    mocks.rewindFiles.mockResolvedValue({ canRewind: false, error: 'no checkpoint' });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('checkpoint');
    }
    expect(mocks.forkSession).not.toHaveBeenCalled();
  });

  test('returns 500 when SDK transcript cannot be read', async () => {
    mocks.getSessionMessages.mockRejectedValue(new Error('ENOENT'));

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-1', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(500);
  });

  test('restores a Codex Git checkpoint then starts the next turn with rebuilt context', async () => {
    const codexThread = { ...claudeThread, provider: 'codex', sessionId: 'codex-session' };
    mocks.tm.getThread.mockResolvedValue(codexThread);
    mocks.tm.getThreadWithMessages.mockResolvedValue({ ...codexThread, messages: dbMessages });
    mocks.restoreCodexCheckpoint.mockResolvedValue({
      canRewind: true,
      filesChanged: ['src/before.ts'],
    });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-2', userId: 'u-1' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.newSessionId).toBeNull();
    expect(mocks.restoreCodexCheckpoint).toHaveBeenCalledWith({
      threadId: 't-1',
      messageId: 'm-user-2',
      cwd: '/repo',
    });
    expect(mocks.rewindFiles).not.toHaveBeenCalled();
    expect(mocks.forkSession).not.toHaveBeenCalled();
    expect(mocks.tm.deleteMessagesAfter).toHaveBeenCalledWith('t-1', 'm-user-2');
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({
        sessionId: null,
        contextRecoveryReason: 'rewound',
        fileCheckpointingEnabled: 1,
      }),
    );
  });

  test('does not truncate a Codex thread when its checkpoint is unavailable', async () => {
    const codexThread = { ...claudeThread, provider: 'codex', sessionId: 'codex-session' };
    mocks.tm.getThread.mockResolvedValue(codexThread);
    mocks.tm.getThreadWithMessages.mockResolvedValue({ ...codexThread, messages: dbMessages });
    mocks.restoreCodexCheckpoint.mockResolvedValue({
      canRewind: false,
      filesChanged: [],
      error: 'No Git checkpoint exists for this message',
    });

    const result = await rewindCode({ threadId: 't-1', messageId: 'm-user-2', userId: 'u-1' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
    expect(mocks.tm.deleteMessagesAfter).not.toHaveBeenCalled();
  });
});

describe('forkAndRewind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAnchorMocks();
    mocks.forkThread.mockResolvedValue(
      ok({
        id: 't-fork',
        sessionId: 'sess-fork',
        worktreePath: '/repo/.worktrees/t-fork',
      }),
    );
  });

  test('forks thread then rewinds files on the fork', async () => {
    const result = await forkAndRewind({
      sourceThreadId: 't-1',
      messageId: 'm-user-1',
      userId: 'u-1',
      title: 'Rewound fork',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.forkThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: 't-1',
        messageId: 'm-user-1',
        title: 'Rewound fork',
      }),
    );
    expect(mocks.rewindFiles).toHaveBeenCalledWith('sdk-uuid-0');
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resume: 'sess-fork', cwd: '/repo/.worktrees/t-fork' }),
      }),
    );
  });

  test('returns 400 for Codex before attempting to fork', async () => {
    mocks.tm.getThread.mockResolvedValue({ ...claudeThread, provider: 'codex' });

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

  test('returns 500 when forked thread has no session', async () => {
    mocks.forkThread.mockResolvedValue(ok({ id: 't-fork', sessionId: null }));

    const result = await forkAndRewind({
      sourceThreadId: 't-1',
      messageId: 'm-user-1',
      userId: 'u-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(500);
  });
});
